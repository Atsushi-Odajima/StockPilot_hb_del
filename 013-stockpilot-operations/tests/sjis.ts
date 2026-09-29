// テスト用 Shift_JIS エンコーダ（TextDecoder から逆引き表を作る）
let table: Map<string, number[]> | null = null;
function build() {
  const m = new Map<string, number[]>();
  const dec = new TextDecoder('shift_jis');
  for (let b = 0; b < 0x80; b++) m.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) m.set(dec.decode(new Uint8Array([b])), [b]);
  const leads = [...Array.from({ length: 0x9f - 0x81 + 1 }, (_, i) => 0x81 + i), ...Array.from({ length: 0xfc - 0xe0 + 1 }, (_, i) => 0xe0 + i)];
  for (const l of leads) {
    for (let t = 0x40; t <= 0xfc; t++) {
      if (t === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([l, t]));
      if (ch.length === 1 && ch !== '�' && !m.has(ch)) m.set(ch, [l, t]);
    }
  }
  return m;
}
export default function toShiftJis(s: string): Buffer {
  table ??= build();
  const out: number[] = [];
  for (const ch of s) {
    const b = table.get(ch);
    if (!b) throw new Error(`cannot encode ${ch}`);
    out.push(...b);
  }
  return Buffer.from(out);
}
