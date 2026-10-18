/**
 * Webcam via getUserMedia. Frames are captured to in-memory JPEG blobs and
 * sent straight to the API; nothing is saved on the device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'starting' | 'ready' | 'denied' | 'unavailable' | 'error';

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      return;
    }
    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStatus('ready');
    } catch (err) {
      const name = (err as DOMException).name;
      setStatus(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'denied'
          : name === 'NotFoundError'
            ? 'unavailable'
            : 'error',
      );
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  /** One JPEG of the current frame, at most `maxWidth` wide. */
  const snapshot = useCallback(async (maxWidth = 640, quality = 0.85): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
  }, []);

  /** `count` frames spaced `intervalMs` apart (gives the liveness check head movement to see). */
  const captureFrames = useCallback(
    async (count: number, intervalMs: number): Promise<Blob[]> => {
      const frames: Blob[] = [];
      for (let i = 0; i < count; i++) {
        const b = await snapshot();
        if (b) frames.push(b);
        if (i < count - 1) await new Promise((r) => setTimeout(r, intervalMs));
      }
      return frames;
    },
    [snapshot],
  );

  return { videoRef, status, start, stop, snapshot, captureFrames };
}
