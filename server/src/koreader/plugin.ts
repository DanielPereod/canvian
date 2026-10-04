import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

// El plugin de KOReader para descargar desde Configuración: los archivos de
// server/koreader/canvian.koplugin más uno con la dirección, la llave y el
// perfil ya puestos, en un .zip que se descomprime en koreader/plugins.

const DIR = 'canvian.koplugin';
// Igual desde src/koreader (tsx) que desde dist/koreader (compilado).
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'koreader', DIR);

export type PluginConfig = { url: string; token: string; profile: string | null; profileName: string | null; lang: 'es' | 'en' };

// Una cadena de Lua entre comillas, sin nada que se pueda escapar de ella.
const luaString = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\x00-\x1f]/g, (c) => `\\${String(c.charCodeAt(0)).padStart(3, '0')}`)}"`;
const luaValue = (v: string | null) => (v === null ? 'nil' : luaString(v));

export function configLua(c: PluginConfig): string {
  return [
    '-- Generado por Canvian (Configuración › KOReader). Se puede cambiar desde el menú del plugin.',
    'return {',
    `  url = ${luaValue(c.url)},`,
    `  token = ${luaValue(c.token)},`,
    `  profile = ${luaValue(c.profile)},`,
    `  profile_name = ${luaValue(c.profileName)},`,
    `  lang = ${luaValue(c.lang)},`,
    '}',
    '',
  ].join('\n');
}

export function pluginZip(c: PluginConfig): Buffer {
  const files = readdirSync(SOURCE)
    .filter((f) => f.endsWith('.lua') && f !== 'canvian_config.lua')
    .sort()
    .map((f) => ({ name: `${DIR}/${f}`, data: readFileSync(join(SOURCE, f)) }));
  files.push({ name: `${DIR}/canvian_config.lua`, data: Buffer.from(configLua(c)) });
  return zip(files);
}

/** Un .zip mínimo (deflate, nombres en UTF-8). */
export function zip(files: { name: string; data: Buffer }[], date = new Date()): Buffer {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
