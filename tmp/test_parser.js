
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');

  return `[${h}:${m}:${s}]`;
}

// Test Input
const segments = [
    { startMs: 1000, text: "Hello" },
    { startMs: 1500, text: "world" }, // Same second
    { startMs: 3000, text: "Three" }
];

// Mock AI Response
const aiResponse = `
[00:00:01] Xin chào
[00:00:01] thế giới
[00:00:03] Thứ ba
`;

function testParsing(segments, response) {
    const regex = /\[(\d{1,2}:\d{2}:\d{2})\]\s*([\s\S]*?)(?=\s*\[\d{1,2}:\d{2}:\d{2}\]|$)/g;
    const parsedQueues = {};
    
    let match;
    while ((match = regex.exec(response)) !== null) {
      const timestamp = match[1];
      const content = match[2].trim();
      
      if (!parsedQueues[timestamp]) parsedQueues[timestamp] = [];
      parsedQueues[timestamp].push(content);
    }

    console.log("Parsed Queues:", parsedQueues);

    const resultLines = segments.map(s => {
      const ts = formatTimestamp(s.startMs).replace(/[\[\]]/g, '');
      if (parsedQueues[ts] && parsedQueues[ts].length > 0) {
        return parsedQueues[ts].shift();
      }
      return s.text;
    });

    console.log("Final Results:", resultLines);
}

testParsing(segments, aiResponse);
