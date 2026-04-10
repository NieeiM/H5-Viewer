declare module 'ooura' {
  interface OouraOptions {
    type?: 'real' | 'complex';
    radix?: number;
  }

  class Ooura {
    constructor(size: number, options?: OouraOptions);
    fft(input: ArrayBuffer, re: ArrayBuffer, im: ArrayBuffer): void;
    ifft(re: ArrayBuffer, im: ArrayBuffer, output: ArrayBuffer): void;
  }

  export default Ooura;
}
