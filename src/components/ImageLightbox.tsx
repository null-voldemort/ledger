import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { ScrollLock } from './ScrollLock';

interface Props {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}

export const ImageLightbox: React.FC<Props> = ({ src, alt, caption, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="no-print fixed inset-0 z-[120] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <ScrollLock />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="absolute top-4 right-4 grid place-items-center w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white transition-colors"
      >
        <X className="w-5 h-5" />
      </button>
      <div className="max-w-2xl max-h-[85vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="max-h-[75vh] max-w-full rounded-2xl shadow-2xl object-contain bg-white" />
        {caption && <div className="text-sm font-medium text-white/90">{caption}</div>}
      </div>
    </div>
  );
};
