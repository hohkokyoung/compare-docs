/** @type {import('next').NextConfig} */
export default {
  // These are loaded by Node at runtime, not bundled: pdfjs and exceljs ship
  // their own worker/format handling, and the OCR stack pulls in native .node
  // binaries (ONNX runtime, Skia canvas) that webpack cannot parse.
  serverExternalPackages: [
    'pdfjs-dist',
    'mammoth',
    'exceljs',
    'ppu-paddle-ocr',
    'ppu-ocv',
    'onnxruntime-node',
    '@napi-rs/canvas',
  ],
  // `npm run build` writes to its own directory so a production build can never
  // overwrite the chunks a running `npm run dev` is serving.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server (its own trimmed node_modules) so the desktop
  // app can run it without a separate `npm install` on the user's machine.
  output: 'standalone',
};
