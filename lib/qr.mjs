'use strict';

import QRCode from 'qrcode';

const QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#14231f', light: '#ffffff' }
};

/** QR code en SVG (net, sans image externe, s'affiche même sans réseau). */
export async function renderQrSvg(text, options = {}) {
  return QRCode.toString(String(text), { ...QR_OPTIONS, type: 'svg', width: options.width || 512 });
}

/** QR code en PNG, utilisé pour les notifications Discord. */
export async function renderQrPngBuffer(text, options = {}) {
  return QRCode.toBuffer(String(text), { ...QR_OPTIONS, type: 'png', width: options.width || 640 });
}
