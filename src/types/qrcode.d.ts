declare module 'qrcode/lib/core/qrcode' {
  interface BitMatrix {
    size: number;
    get(row: number, col: number): number | boolean;
  }
  export function create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: BitMatrix; version: number };
}
