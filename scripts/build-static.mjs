import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const staticDirectories = [
  'css',
  'js',
  'images',
  'elementary',
  'middle',
  'high',
  'teacher',
  'thinking-tools',
];
const root = process.cwd();
const output = join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const entries = await readdir(root, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isFile() && entry.name.endsWith('.html')) {
    await cp(join(root, entry.name), join(output, entry.name));
  }
}

for (const directory of staticDirectories) {
  await cp(join(root, directory), join(output, directory), { recursive: true });
}
