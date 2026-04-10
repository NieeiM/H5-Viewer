declare module 'mat-for-js' {
  export function read(buffer: ArrayBuffer): {
    header: string;
    data: Record<string, unknown>;
  };
}
