const form = document.querySelector('#issue-form');
const idInput = document.querySelector('#installation-id');
const submitButton = document.querySelector('#submit-button');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const licenseCode = document.querySelector('#license-code');
const qrImage = document.querySelector('#qr-image');
const downloadQr = document.querySelector('#download-qr');
const copyButton = document.querySelector('#copy-license');

if (form) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    result.hidden = true;
    status.className = 'status';
    status.textContent = '';
    const installationId = idInput.value.trim();
    if (!installationId) {
      status.classList.add('error');
      status.textContent = 'Ingresa el ID de instalación.';
      return;
    }

    submitButton.disabled = true;
    submitButton.classList.add('loading');
    submitButton.querySelector('.button-label').textContent = 'Emitiendo…';
    status.textContent = 'Firmando la licencia y preparando el QR…';

    try {
      const response = await fetch('/api/licenses/issue/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId }),
        cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'No se pudo emitir la licencia.');
      if (typeof body.data?.license !== 'string' || typeof body.data?.qrDataUrl !== 'string' ||
          !body.data.qrDataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('El servidor devolvió una respuesta de licencia inválida.');
      }

      licenseCode.value = body.data.license;
      qrImage.src = body.data.qrDataUrl;
      downloadQr.href = body.data.qrDataUrl;
      result.hidden = false;
      status.classList.add('success');
      status.textContent = 'Licencia emitida correctamente.';
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      status.classList.add('error');
      status.textContent = error instanceof TypeError
        ? 'No se pudo conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
        : error.message;
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove('loading');
      submitButton.querySelector('.button-label').textContent = 'Emitir licencia';
    }
  });
}

if (copyButton) {
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(licenseCode.value);
      copyButton.textContent = 'Código copiado';
    } catch {
      licenseCode.focus();
      licenseCode.select();
      copyButton.textContent = 'Selecciona y copia el código';
    }
  });
}
