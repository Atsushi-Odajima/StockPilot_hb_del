// バーコード・QR 読取。映像は端末内でだけ処理し、外部へ送らない。
// 1) ブラウザ組込み BarcodeDetector があり、必要な形式に対応していればそれを使う
// 2) なければ端末内 WebAssembly デコーダ（zxing-wasm、自前配信）に切り替える
import { BarcodeDetector as PonyDetector, prepareZXingModule } from 'barcode-detector/ponyfill';

export const WANTED_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128'] as const;

let prepared = false;
function prepare() {
  if (prepared) return;
  prepared = true;
  prepareZXingModule({
    overrides: {
      locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? `/wasm/${p}` : prefix + p),
    },
  });
}

export interface Detector {
  engine: 'native' | 'wasm';
  formats: string[];
  detect(source: CanvasImageSource | ImageBitmapSource): Promise<{ rawValue: string; format: string }[]>;
}

export async function createDetector(): Promise<Detector> {
  const Native = (globalThis as any).BarcodeDetector;
  if (Native && typeof Native.getSupportedFormats === 'function') {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('qr_code') && formats.includes('ean_13')) {
        const d = new Native({ formats });
        return { engine: 'native', formats, detect: (s) => d.detect(s) };
      }
    } catch {
      /* ネイティブが使えない場合は wasm へ */
    }
  }
  prepare();
  const d = new PonyDetector({ formats: [...WANTED_FORMATS] });
  return { engine: 'wasm', formats: [...WANTED_FORMATS], detect: (s) => d.detect(s as any) as any };
}

export function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (!window.isSecureContext) return 'カメラはHTTPSで開いたページでのみ使えます。';
  if (!navigator.mediaDevices?.getUserMedia) return 'このブラウザではカメラを利用できません。検索欄やコード入力を使ってください。';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラの利用が許可されていません。ブラウザの設定（iPhoneは「設定→Safari→カメラ」）で許可してから、もう一度お試しください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりません。検索欄やコード入力を使ってください。';
    case 'NotReadableError':
    case 'AbortError':
      return '他のアプリがカメラを使用中の可能性があります。他のアプリを閉じてからお試しください。';
    default:
      return 'カメラを開始できませんでした。検索欄やコード入力を使ってください。';
  }
}
