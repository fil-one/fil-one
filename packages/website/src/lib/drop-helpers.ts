import type { FileInput } from './use-file-upload.js';

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    function read() {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(entries);
        else {
          entries.push(...batch);
          read();
        }
      }, reject);
    }
    read();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectEntryFiles(
  entry: FileSystemEntry,
  dirPath: string,
): Promise<Array<{ file: File; dirPath: string }>> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    return [{ file, dirPath }];
  }
  if (entry.isDirectory) {
    const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
    const children = await readEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(children.map((c) => collectEntryFiles(c, childPath)));
    return nested.flat();
  }
  return [];
}

export async function resolveDropItems(dataTransfer: DataTransfer): Promise<FileInput[]> {
  const items = Array.from(dataTransfer.items);
  if (!items[0]?.webkitGetAsEntry) {
    return Array.from(dataTransfer.files);
  }
  const results = await Promise.all(
    items.map(async (item) => {
      const entry = item.webkitGetAsEntry();
      if (!entry) return [] as Array<{ file: File; dirPath: string }>;
      return collectEntryFiles(entry, '');
    }),
  );
  return results.flat().map(({ file, dirPath }) => {
    if (!dirPath) return file;
    return { file, relativePath: `${dirPath}/${file.name}` };
  });
}
