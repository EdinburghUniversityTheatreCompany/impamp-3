// Minimal typings for the File System Access API's save picker, which is not
// yet part of TypeScript's lib.dom. Chromium-only; feature-detect before use.
// (FileSystemFileHandle/createWritable ARE in lib.dom already.)

interface SaveFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: SaveFilePickerAcceptType[];
}

interface Window {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>;
}
