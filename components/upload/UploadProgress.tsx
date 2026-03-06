"use client";

interface UploadProgressProps {
  progress: number;
  statusText?: string;
}

export function UploadProgress({ progress, statusText }: UploadProgressProps) {
  return (
    <div className="space-y-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-2 rounded-full bg-gradient-to-r from-accent-soft to-accent-primary transition-all"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <p className="text-xs text-text-soft">
        {statusText ?? `진행률: ${Math.round(progress)}%`}
      </p>
    </div>
  );
}

