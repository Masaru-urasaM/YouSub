/**
 * options-modal.js — Accessible confirmation dialog helper for the Options page.
 */
export function showConfirmModal(modalEls, title, message, onConfirm) {
  const { confirmModal, modalTitle, modalMessage, modalCancelBtn, modalConfirmBtn } = modalEls;
  if (!confirmModal) return;

  modalTitle.textContent = title;
  modalMessage.textContent = message;

  // A11y: remember the element that opened the modal so focus can return to it
  const opener = document.activeElement;

  const handleConfirm = () => {
    closeModal();
    onConfirm();
  };

  const handleCancel = () => {
    closeModal();
  };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const closeModal = () => {
    confirmModal.classList.add('hidden');
    modalConfirmBtn.removeEventListener('click', handleConfirm);
    modalCancelBtn.removeEventListener('click', handleCancel);
    confirmModal.removeEventListener('keydown', handleKeydown);
    if (opener && typeof opener.focus === 'function') opener.focus();
  };

  modalConfirmBtn.addEventListener('click', handleConfirm);
  modalCancelBtn.addEventListener('click', handleCancel);
  confirmModal.addEventListener('keydown', handleKeydown);

  confirmModal.onclick = (e) => {
    if (e.target === confirmModal) closeModal();
  };

  confirmModal.classList.remove('hidden');
  modalCancelBtn.focus();
}
