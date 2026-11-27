import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  title?: string;
  maxWidth?: number;
  quality?: number;
  onClose: () => void;
  onCapture: (file: { name: string; data: string }) => void;
}

export const CameraCaptureModal: React.FC<Props> = ({
  isOpen,
  title = 'Capture Voucher Photo',
  maxWidth = 1280,
  quality = 0.84,
  onClose,
  onCapture,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startCamera = useCallback(async (mode: 'environment' | 'user') => {
    stopStream();
    setError('');
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Live camera is unavailable in this browser. Use Upload / Mobile Camera below.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setError('Camera permission denied or no camera found. Use Upload / Mobile Camera below.');
    } finally {
      setStarting(false);
    }
  }, [stopStream]);

  useEffect(() => {
    if (!isOpen) {
      stopStream();
      setPreview(null);
      setError('');
      return;
    }
    if (!preview) {
      void startCamera(facingMode);
    }
    return () => {
      stopStream();
    };
  }, [isOpen, facingMode, preview, startCamera, stopStream]);

  if (!isOpen) return null;

  const snapPhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    stopStream();
    setPreview(dataUrl);
  };

  const handleFallbackFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      stopStream();
      setPreview(dataUrl);
      setError('');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      setError('Could not read the selected image.');
    };
    img.src = objUrl;
  };

  const confirmUse = () => {
    if (!preview) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    onCapture({ name: `voucher-${stamp}.jpg`, data: preview });
    onClose();
  };

  return (
    <div className="no-print fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-6 bg-slate-950/70 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white w-full max-w-xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[92vh]"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center w-9 h-9 rounded-xl bg-brand-50 text-brand-700">
              <Camera className="w-4 h-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-[#1b2a4e]">{title}</h2>
              <p className="text-[11px] text-slate-500">Saved directly to the ledger database.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid place-items-center w-8 h-8 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[4/3] grid place-items-center border border-slate-200">
            {preview ? (
              <img src={preview} alt="Captured voucher" className="w-full h-full object-contain" />
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${error ? 'opacity-20' : 'opacity-100'}`}
                />
                {starting && !error && (
                  <div className="absolute inset-0 grid place-items-center text-xs text-white/80 font-medium">
                    Starting camera...
                  </div>
                )}
                {error && (
                  <div className="absolute inset-0 p-6 grid place-items-center text-center">
                    <div className="space-y-3 max-w-xs">
                      <p className="text-xs text-white/90 font-medium">{error}</p>
                      <label className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold cursor-pointer">
                        <Upload className="w-3.5 h-3.5" /> Take / Choose Photo
                        <input type="file" accept="image/*" capture="environment" onChange={handleFallbackFile} className="hidden" />
                      </label>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {!preview ? (
              <>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'))}
                    className="h-9 px-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Switch Camera
                  </button>
                  <label className="h-9 px-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" /> From Device
                    <input type="file" accept="image/*" capture="environment" onChange={handleFallbackFile} className="hidden" />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={Boolean(error) || starting}
                  onClick={snapPhoto}
                  className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Camera className="w-4 h-4" /> Capture Photo
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="h-9 px-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Retake
                </button>
                <button
                  type="button"
                  onClick={confirmUse}
                  className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" /> Attach to Entry
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
