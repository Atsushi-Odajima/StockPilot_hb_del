import { useEffect, useRef, useState } from 'react';
import { cameraErrorMessage, createDetector, type Detector } from '../lib/scanner';

interface Props {
  onDetected: (text: string, format: string) => void;
  onClose: () => void;
  hint?: string;
}

/**
 * カメラ読取。利用者が明示的に開いたときだけ背面カメラを起動する。
 * 1件読み取ったら止める（連続検出で数量を加算しない）。画面離脱・非表示時はカメラを停止する。
 */
export function Scanner({ onDetected, onClose, hint }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('カメラを準備しています…');
  const [engine, setEngine] = useState<string>('');
  const doneRef = useRef(false);
  const detectorRef = useRef<Detector | null>(null);

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let timer: number | undefined;
    const canvas = document.createElement('canvas');
    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(cameraErrorMessage(new Error('insecure')));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        detectorRef.current = await createDetector();
        setEngine(detectorRef.current.engine === 'native' ? 'ブラウザ内蔵の読取機能' : '端末内デコーダ（WebAssembly）');
        setStatus('コードを枠の中に写してください');
        const loop = async () => {
          if (cancelled || doneRef.current) return;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            try {
              // 中央部分を切り出して読み取る（処理を軽くし、隣のコードの誤読を減らす）
              const w = v.videoWidth;
              const h = v.videoHeight;
              const cw = Math.round(w * 0.8);
              const ch = Math.round(h * 0.6);
              canvas.width = cw;
              canvas.height = ch;
              const ctx2 = canvas.getContext('2d', { willReadFrequently: true })!;
              ctx2.drawImage(v, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
              const res = await detectorRef.current!.detect(canvas);
              if (res.length && !doneRef.current) {
                doneRef.current = true;
                navigator.vibrate?.(60);
                stop();
                onDetected(res[0].rawValue, res[0].format);
                return;
              }
            } catch {
              /* 1フレームの失敗は無視 */
            }
          }
          timer = window.setTimeout(() => (raf = requestAnimationFrame(loop)), 120);
        };
        loop();
      } catch (e) {
        setError(cameraErrorMessage(e));
      }
    };
    start();
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        onClose();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', stop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      stop();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="コード読取">
      <div className="scanner-view">
        <video ref={videoRef} playsInline muted aria-label="カメラ映像" />
        <div className="scanner-frame" aria-hidden="true" />
      </div>
      <div className="scanner-panel">
        {error ? <p className="msg msg-error">{error}</p> : <p className="scanner-status">{status}</p>}
        {hint && <p className="muted small">{hint}</p>}
        {engine && <p className="muted small">読取方式：{engine}。映像は端末内で処理し、外部へ送信しません。</p>}
        <p className="muted small">ピントが合わない場合は、少し離してから近づけてください。</p>
        <button className="btn btn-block" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
