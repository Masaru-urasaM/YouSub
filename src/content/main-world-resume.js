/**
 * main-world-resume.js — Runs in the MAIN world (YouTube page context via
 * manifest content_scripts world: "MAIN").
 *
 * Responsibilities:
 *  1. Extract YouTube account playbackStartConfig.startSeconds & videostatsWatchtimeUrl
 *     from active player / ytInitialPlayerResponse / Innertube /youtubei/v1/player.
 *  2. Intercept outgoing /api/stats/watchtime requests (fetch, XHR, sendBeacon) to:
 *     - Guard against YouTube's premature 0:00 overwrite bug during the first ~15s.
 *     - Clamp >= 95% completion pings on long videos (>= 600s) so falling asleep
 *       does not reset account progress to 0:00.
 *     - Capture live session cpn / template params for reliable pushes.
 *  3. Actively push credentialed watchtime pings to same-origin YouTube endpoint on
 *     pause / seek / visibilitychange / pagehide to keep Chrome <-> Firefox account sync current.
 */
(function () {
  'use strict';

  try {
    if (window.__yousubMainResumeReady) return;
    window.__yousubMainResumeReady = true;

    var MAX_CACHED_VIDEOS = 20;
    var guardState = {
      videoId: null,
      protectedMinTimeSec: 0,
      guardUntilMs: 0,
      preventCompletionReset: true,
      durationSec: 0,
    };

    var cachedWatchtimeUrlByVideoId = new Map();
    var cachedCpnByVideoId = new Map();
    var cachedLiveTemplateByVideoId = new Map();

    function emitLog(level, msg, data) {
      try {
        window.postMessage(
          {
            type: 'YOUSUB_RESUME_LOG',
            level: level || 'INFO',
            tag: 'MainWorldResume',
            msg: String(msg || ''),
            data: data || {},
          },
          '*'
        );
      } catch {}
    }

    function setBoundedMap(map, key, val) {
      if (!key || !val) return;
      if (map.has(key)) map.delete(key);
      map.set(key, val);
      while (map.size > MAX_CACHED_VIDEOS) {
        var firstKey = map.keys().next().value;
        map.delete(firstKey);
      }
    }

    function resolveYoutubeOrigin(loc) {
      if (
        loc &&
        loc.origin &&
        loc.hostname &&
        (loc.hostname === 'youtube.com' || loc.hostname.endsWith('.youtube.com'))
      ) {
        return loc.origin;
      }
      return 'https://www.youtube.com';
    }

    function getActivePlayer() {
      return (
        document.getElementById('movie_player') ||
        document.getElementById('shorts-player') ||
        document.getElementById('player-container-id') ||
        document.querySelector('.html5-video-player')
      );
    }

    function generateCpn() {
      var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      var out = '';
      for (var i = 0; i < 16; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
      }
      return out;
    }

    function clampCsvList(csvStr, maxVal) {
      if (!csvStr) return String(maxVal);
      var parts = String(csvStr)
        .split(',')
        .map(function (item) {
          var n = parseFloat(item);
          if (!Number.isFinite(n)) return item;
          return n > maxVal ? String(maxVal) : item;
        });
      return parts.join(',');
    }

    /**
     * Pure helper to inspect and rewrite outgoing /api/stats/watchtime URLs.
     * Returns the (possibly rewritten) URL string.
     */
    function rewriteWatchtimeUrl(rawUrl, options) {
      if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
      if (rawUrl.indexOf('/api/stats/watchtime') === -1) return rawUrl;

      var opts = options || {};
      var baseOrigin = opts.youtubeOrigin || resolveYoutubeOrigin(window.location);

      try {
        var parsed = new URL(rawUrl, baseOrigin);
        if (!parsed.pathname || parsed.pathname.indexOf('/api/stats/watchtime') === -1) {
          return rawUrl;
        }

        var modified = false;

        if (opts.forceSameOrigin && parsed.hostname === 's.youtube.com') {
          var targetOriginUrl = new URL(baseOrigin);
          parsed.protocol = targetOriginUrl.protocol;
          parsed.host = targetOriginUrl.host;
          modified = true;
        }

        var docid = parsed.searchParams.get('docid') || parsed.searchParams.get('v') || '';
        var targetVideoId = opts.videoId || '';
        var videoMatches = !targetVideoId || !docid || docid === targetVideoId;

        if (videoMatches) {
          var cmtRaw = parsed.searchParams.get('cmt');
          var cmt = cmtRaw !== null ? parseFloat(cmtRaw) : NaN;
          var nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
          var guardUntilMs = Number(opts.guardUntilMs) || 0;
          var protectedMin = Number(opts.protectedMinTimeSec) || 0;
          var durationSec = Number(opts.durationSec) || 0;
          var preventReset = opts.preventCompletionReset !== false;

          // Rule 1: Guard against premature 0:00 overwrite right after opening a video
          if (
            nowMs < guardUntilMs &&
            protectedMin >= 15 &&
            Number.isFinite(cmt) &&
            cmt < protectedMin - 10
          ) {
            var safeFloorStr = protectedMin.toFixed(1);
            parsed.searchParams.set('cmt', safeFloorStr);
            parsed.searchParams.set('st', safeFloorStr);
            parsed.searchParams.set('et', safeFloorStr);
            modified = true;
            if (typeof opts.onRewrite === 'function') {
              opts.onRewrite('GUARD_REWRITE', {
                videoId: docid || targetVideoId,
                originalCmt: cmt,
                rewrittenCmt: safeFloorStr,
              });
            }
          } else if (
            preventReset &&
            durationSec >= 600 &&
            Number.isFinite(cmt) &&
            cmt >= durationSec * 0.95
          ) {
            // Rule 2: Prevent >95% completion reset when sleeping through long audiobooks
            var safeCap = Math.floor(durationSec * 0.9);
            parsed.searchParams.set('cmt', String(safeCap));
            if (parsed.searchParams.has('et')) {
              parsed.searchParams.set('et', clampCsvList(parsed.searchParams.get('et'), safeCap));
            }
            if (parsed.searchParams.has('st')) {
              parsed.searchParams.set('st', clampCsvList(parsed.searchParams.get('st'), safeCap));
            }
            modified = true;
            if (typeof opts.onRewrite === 'function') {
              opts.onRewrite('CLAMP_95_REWRITE', {
                videoId: docid || targetVideoId,
                originalCmt: cmt,
                clampedCmt: safeCap,
                durationSec: durationSec,
              });
            }
          }
        }

        return modified ? parsed.toString() : rawUrl;
      } catch {
        return rawUrl;
      }
    }

    /**
     * Build a credentialed same-origin watchtime push URL from baseUrl + current playback time.
     */
    function buildActiveWatchtimePushUrl(baseUrl, options) {
      if (!baseUrl || typeof baseUrl !== 'string') return '';
      var opts = options || {};
      var baseOrigin = opts.youtubeOrigin || resolveYoutubeOrigin(window.location);

      try {
        var parsed = new URL(baseUrl, baseOrigin);
        if (parsed.hostname === 's.youtube.com') {
          var targetOrigin = new URL(baseOrigin);
          parsed.protocol = targetOrigin.protocol;
          parsed.host = targetOrigin.host;
        }

        var durationSec = Number(opts.durationSec) || 0;
        var currentTimeSec = Math.max(0, Number(opts.currentTimeSec) || 0);
        var preventReset = opts.preventCompletionReset !== false;

        var effectiveTime = currentTimeSec;
        if (preventReset && durationSec >= 600 && effectiveTime >= durationSec * 0.95) {
          effectiveTime = Math.floor(durationSec * 0.9);
        }

        var timeStr = effectiveTime.toFixed(1);
        parsed.searchParams.set('cmt', timeStr);
        parsed.searchParams.set('st', timeStr);
        parsed.searchParams.set('et', timeStr);
        if (durationSec > 0) {
          parsed.searchParams.set('len', String(Math.round(durationSec)));
        }
        var state = opts.state === 'playing' ? 'playing' : 'paused';
        parsed.searchParams.set('state', state);
        parsed.searchParams.set('ver', '2');
        if (state === 'paused') {
          parsed.searchParams.set('final', '1');
        } else {
          parsed.searchParams.delete('final');
        }

        var cpn = opts.cpn || parsed.searchParams.get('cpn') || generateCpn();
        parsed.searchParams.set('cpn', cpn);

        if (opts.videoId && !parsed.searchParams.get('docid')) {
          parsed.searchParams.set('docid', opts.videoId);
        }

        return parsed.toString();
      } catch {
        return '';
      }
    }

    function captureSessionTokens(rawUrl) {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      if (
        rawUrl.indexOf('/api/stats/watchtime') === -1 &&
        rawUrl.indexOf('/api/stats/playback') === -1
      ) {
        return;
      }
      try {
        var parsed = new URL(rawUrl, resolveYoutubeOrigin(window.location));
        var docid = parsed.searchParams.get('docid') || parsed.searchParams.get('v') || '';
        var cpn = parsed.searchParams.get('cpn') || '';
        if (docid && cpn) {
          setBoundedMap(cachedCpnByVideoId, docid, cpn);
        }
        if (docid && parsed.pathname.indexOf('/api/stats/watchtime') !== -1) {
          setBoundedMap(cachedLiveTemplateByVideoId, docid, parsed.toString());
        }
      } catch {}
    }

    function extractPlayerResumeData(resp) {
      if (!resp || typeof resp !== 'object') {
        return {
          accountStartSec: 0,
          watchtimeBaseUrl: '',
          durationSec: 0,
          isLive: false,
          title: document.title || '',
        };
      }
      var startRaw =
        resp.playerConfig &&
        resp.playerConfig.playbackStartConfig &&
        resp.playerConfig.playbackStartConfig.startSeconds;
      var accountStartSec = Number.isFinite(Number(startRaw)) ? Math.max(0, Number(startRaw)) : 0;

      var watchtimeBaseUrl =
        (resp.playbackTracking &&
          resp.playbackTracking.videostatsWatchtimeUrl &&
          resp.playbackTracking.videostatsWatchtimeUrl.baseUrl) ||
        '';

      var videoDetails = resp.videoDetails || {};
      var durationSec = Number.isFinite(Number(videoDetails.lengthSeconds))
        ? Math.max(0, Number(videoDetails.lengthSeconds))
        : 0;
      var isLive = Boolean(videoDetails.isLive || videoDetails.isLiveContent);
      var title =
        typeof videoDetails.title === 'string' ? videoDetails.title : document.title || '';

      return {
        accountStartSec: accountStartSec,
        watchtimeBaseUrl: watchtimeBaseUrl,
        durationSec: durationSec,
        isLive: isLive,
        title: title,
      };
    }

    function buildInnertubeContext() {
      var existing =
        window.ytcfg && typeof window.ytcfg.get === 'function'
          ? window.ytcfg.get('INNERTUBE_CONTEXT')
          : null;
      if (existing && typeof existing === 'object') {
        return existing;
      }
      var clientVersion = '2.20261116.00.00';
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || clientVersion;
      }
      return {
        client: {
          clientName:
            window.location && window.location.hostname === 'm.youtube.com' ? 'MWEB' : 'WEB',
          clientVersion: clientVersion,
          hl: (navigator.language || 'en').split('-')[0],
        },
      };
    }

    // Keep raw references before installing interception hooks so active pushes bypass hooks
    var origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    var origXhrOpen =
      typeof XMLHttpRequest !== 'undefined' &&
      XMLHttpRequest.prototype &&
      typeof XMLHttpRequest.prototype.open === 'function'
        ? XMLHttpRequest.prototype.open
        : null;
    var origSendBeacon =
      typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : null;

    function fetchPlayerResponseViaInnertube(videoId) {
      return new Promise(function (resolve) {
        try {
          var apiKey = '';
          var clientName = '';
          var clientVersion = '';
          if (window.ytcfg && typeof window.ytcfg.get === 'function') {
            apiKey = window.ytcfg.get('INNERTUBE_API_KEY') || '';
            clientName = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || '';
            clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || '';
          }
          var origin = resolveYoutubeOrigin(window.location);
          var url =
            origin + '/youtubei/v1/player' + (apiKey ? '?key=' + encodeURIComponent(apiKey) : '');

          var xhr = new XMLHttpRequest();
          origXhrOpen ? origXhrOpen.call(xhr, 'POST', url, true) : xhr.open('POST', url, true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          if (clientName) xhr.setRequestHeader('X-YouTube-Client-Name', String(clientName));
          if (clientVersion)
            xhr.setRequestHeader('X-YouTube-Client-Version', String(clientVersion));
          xhr.withCredentials = true;
          xhr.timeout = 6000;

          var done = false;
          xhr.onload = function () {
            if (done) return;
            done = true;
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          };
          xhr.onerror = function () {
            if (!done) {
              done = true;
              resolve(null);
            }
          };
          xhr.ontimeout = function () {
            if (!done) {
              done = true;
              resolve(null);
            }
          };
          xhr.send(JSON.stringify({ videoId: videoId, context: buildInnertubeContext() }));
        } catch {
          resolve(null);
        }
      });
    }

    function maybeRewriteOutgoingUrl(rawUrl) {
      captureSessionTokens(rawUrl);
      return rewriteWatchtimeUrl(rawUrl, {
        videoId: guardState.videoId,
        protectedMinTimeSec: guardState.protectedMinTimeSec,
        guardUntilMs: guardState.guardUntilMs,
        preventCompletionReset: guardState.preventCompletionReset,
        durationSec: guardState.durationSec,
        onRewrite: function (eventTag, details) {
          emitLog('INFO', '[' + eventTag + '] Rewrote outgoing watchtime ping', details);
        },
      });
    }

    // Install lightweight, guarded hooks on fetch, XHR.open, and sendBeacon
    try {
      if (origFetch) {
        window.fetch = function (input, init) {
          try {
            if (typeof input === 'string') {
              input = maybeRewriteOutgoingUrl(input);
            } else if (input && typeof input === 'object' && typeof input.url === 'string') {
              var nextUrl = maybeRewriteOutgoingUrl(input.url);
              if (nextUrl !== input.url && typeof Request !== 'undefined') {
                input = new Request(nextUrl, input);
              }
            }
          } catch {}
          return origFetch(input, init);
        };
      }
    } catch {}

    try {
      if (origXhrOpen) {
        XMLHttpRequest.prototype.open = function (method, url) {
          try {
            if (typeof url === 'string') {
              var rewritten = maybeRewriteOutgoingUrl(url);
              var args = Array.prototype.slice.call(arguments);
              args[1] = rewritten;
              return origXhrOpen.apply(this, args);
            }
          } catch {}
          return origXhrOpen.apply(this, arguments);
        };
      }
    } catch {}

    var sendBeaconTarget = null;
    try {
      if (origSendBeacon) {
        var wrappedBeacon = function (url, data) {
          try {
            if (typeof url === 'string') {
              url = maybeRewriteOutgoingUrl(url);
            }
          } catch {}
          return origSendBeacon(url, data);
        };
        if (
          typeof navigator !== 'undefined' &&
          Object.prototype.hasOwnProperty.call(navigator, 'sendBeacon')
        ) {
          sendBeaconTarget = navigator;
          navigator.sendBeacon = wrappedBeacon;
        } else if (
          typeof Navigator !== 'undefined' &&
          Navigator.prototype &&
          typeof Navigator.prototype.sendBeacon === 'function'
        ) {
          sendBeaconTarget = Navigator.prototype;
          Navigator.prototype.sendBeacon = wrappedBeacon;
        } else if (typeof navigator !== 'undefined') {
          sendBeaconTarget = navigator;
          Object.defineProperty(navigator, 'sendBeacon', {
            value: wrappedBeacon,
            writable: true,
            configurable: true,
          });
        }
      }
    } catch {}

    async function handleProbePlayer(data) {
      var videoId = data.videoId;
      var requestId = data.requestId;
      if (!videoId) return;

      var matchedResp = null;
      var player = getActivePlayer();
      if (player && typeof player.getPlayerResponse === 'function') {
        try {
          var pr = player.getPlayerResponse();
          if (pr && pr.videoDetails && pr.videoDetails.videoId === videoId) {
            matchedResp = pr;
          }
        } catch {}
      }

      if (
        !matchedResp &&
        window.ytInitialPlayerResponse &&
        window.ytInitialPlayerResponse.videoDetails &&
        window.ytInitialPlayerResponse.videoDetails.videoId === videoId
      ) {
        matchedResp = window.ytInitialPlayerResponse;
      }

      if (!matchedResp) {
        emitLog('DEBUG', '[PROBE_INNERTUBE] Fetching fresh playerResponse for SPA video', {
          videoId: videoId,
        });
        matchedResp = await fetchPlayerResponseViaInnertube(videoId);
      }

      var extracted = extractPlayerResumeData(matchedResp);
      if (extracted.watchtimeBaseUrl) {
        setBoundedMap(cachedWatchtimeUrlByVideoId, videoId, extracted.watchtimeBaseUrl);
      }

      window.postMessage(
        {
          type: 'YOUSUB_RESUME_PLAYER_DATA',
          requestId: requestId,
          videoId: videoId,
          accountStartSec: extracted.accountStartSec,
          watchtimeBaseUrl: extracted.watchtimeBaseUrl,
          durationSec: extracted.durationSec,
          isLive: extracted.isLive,
          title: extracted.title,
        },
        '*'
      );
    }

    function handleSetGuard(data) {
      guardState.videoId = data.videoId || null;
      guardState.protectedMinTimeSec = Number(data.protectedMinTimeSec) || 0;
      guardState.guardUntilMs = Date.now() + (Number(data.guardDurationMs) || 15000);
      guardState.preventCompletionReset = data.preventCompletionReset !== false;
      guardState.durationSec = Number(data.durationSec) || 0;
    }

    function handlePushWatchtime(data) {
      var videoId = data.videoId;
      if (!videoId) return;

      var templateUrl =
        cachedLiveTemplateByVideoId.get(videoId) || cachedWatchtimeUrlByVideoId.get(videoId);
      if (!templateUrl) {
        emitLog('DEBUG', '[PUSH_SKIPPED] No videostatsWatchtimeUrl cached for video', {
          videoId: videoId,
        });
        return;
      }

      var pushUrl = buildActiveWatchtimePushUrl(templateUrl, {
        videoId: videoId,
        currentTimeSec: data.currentTimeSec,
        durationSec: data.durationSec || guardState.durationSec,
        state: data.state || 'paused',
        preventCompletionReset: guardState.preventCompletionReset,
        cpn: cachedCpnByVideoId.get(videoId) || '',
        youtubeOrigin: resolveYoutubeOrigin(window.location),
      });
      if (!pushUrl) return;

      if (origFetch) {
        origFetch(pushUrl, { method: 'GET', credentials: 'include', keepalive: true })
          .then(function (res) {
            if (!res || !res.ok) {
              emitLog('WARN', '[PUSH_FAILED] Watchtime push non-OK response', {
                videoId: videoId,
                status: res ? res.status : 0,
              });
            }
          })
          .catch(function (err) {
            emitLog('WARN', '[PUSH_FAILED] Watchtime fetch failed, trying beacon', {
              videoId: videoId,
              error: err && err.message ? err.message : 'network',
            });
            if (origSendBeacon) {
              try {
                origSendBeacon(pushUrl);
              } catch {}
            }
          });
      } else if (origSendBeacon) {
        try {
          origSendBeacon(pushUrl);
        } catch {}
      }
    }

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'YOUSUB_RESUME_PROBE_PLAYER') {
        handleProbePlayer(data);
      } else if (data.type === 'YOUSUB_RESUME_SET_GUARD') {
        handleSetGuard(data);
      } else if (data.type === 'YOUSUB_RESUME_PUSH_WATCHTIME') {
        handlePushWatchtime(data);
      }
    });

    // Expose pure helpers & test hooks for unit testing
    window.__yousubMainResumeHelpers = {
      resolveYoutubeOrigin: resolveYoutubeOrigin,
      rewriteWatchtimeUrl: rewriteWatchtimeUrl,
      buildActiveWatchtimePushUrl: buildActiveWatchtimePushUrl,
      extractPlayerResumeData: extractPlayerResumeData,
      _getState: function () {
        return {
          guardState: guardState,
          cachedWatchtimeUrlByVideoId: cachedWatchtimeUrlByVideoId,
          cachedCpnByVideoId: cachedCpnByVideoId,
          cachedLiveTemplateByVideoId: cachedLiveTemplateByVideoId,
        };
      },
      _restoreHooks: function () {
        try {
          if (origFetch) window.fetch = origFetch;
        } catch {}
        try {
          if (origXhrOpen && typeof XMLHttpRequest !== 'undefined') {
            XMLHttpRequest.prototype.open = origXhrOpen;
          }
        } catch {}
        try {
          if (origSendBeacon && sendBeaconTarget) {
            sendBeaconTarget.sendBeacon = origSendBeacon;
          }
        } catch {}
      },
    };
  } catch (globalErr) {
    console.error('[YouSub] MainWorldResume Fatal Crash:', globalErr);
  }
})();
