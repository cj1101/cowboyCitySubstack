"use client";

export function CameraRollInput({
  accept = "image/*,video/*",
  multiple = true,
  onFiles,
  label = "Choose from camera roll",
}: {
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  label?: string;
}) {
  return (
    <label className="btn btn-secondary relative inline-flex items-center justify-center min-h-11 w-full sm:w-auto text-base px-4 py-2 text-center">
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </label>
  );
}
