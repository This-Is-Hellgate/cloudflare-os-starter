/**
 * Web standard globals the stage package relies on. The stage package has no Wrangler Env of its
 * own (it is a library), so it declares the runtime surface it depends on directly. The providers
 * use their own generated worker types; these declarations must not conflict with them.
 */

declare class TextEncoder {
  encode(value: string): Uint8Array;
}

declare const crypto: {
  subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
};
