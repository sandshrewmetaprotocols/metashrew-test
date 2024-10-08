import EventEmitter from "events";
import { KeyValueFlush } from "./proto/metashrew";
import chunk from "lodash/chunk";

export const readArrayBufferAsUtf8 = (
  memory: WebAssembly.Memory,
  ptr: number
) => {
  return Buffer.from(
    Array.from(new Uint8Array(readArrayBuffer(memory, ptr)))
  ).toString("utf8");
};

export const readArrayBufferAsHex = (
  memory: WebAssembly.Memory,
  ptr: number
) => {
  return (
    "0x" +
    Buffer.from(
      Array.from(new Uint8Array(readArrayBuffer(memory, ptr)))
    ).toString("hex")
  );
};

export const toU32LEBytes = (n) => {
  const ary = new Uint32Array(1);
  ary[0] = n;
  const byteArray = new Uint8Array(ary.buffer);
  return Buffer.from(Array.from(byteArray));
};

export const readArrayBuffer = (memory: WebAssembly.Memory, ptr: number) => {
  const ary = Array.from(new Uint8Array(memory.buffer));
  const data = Buffer.from(ary);
  const length = data.readUInt32LE(ptr - 4);
  return new Uint8Array(ary.slice(ptr, ptr + length)).buffer;
};

const stripHexPrefix = (s) => (s.substr(0, 2) === "0x" ? s.substr(2) : s);
const addHexPrefix = (s) => (s.substr(0, 2) === "0x" ? s : "0x" + s);

export function toHex(v: Uint8Array): string {
  return addHexPrefix(Buffer.from(Array.from(v)).toString("hex"));
}

export function fromHex(v: string): Uint8Array {
  return new Uint8Array(Array.from(Buffer.from(stripHexPrefix(v), "hex")));
}

export function fromKeyValueFlush(hex: string): string[] {
  return KeyValueFlush.fromBinary(fromHex(hex)).list.map((v) => toHex(v));
}

export class IndexPointer {
  public key: string;
  public program: any;
  constructor(program: any, key: string) {
    this.key = addHexPrefix(key);
    this.program = program;
  }
  get(): string {
    return this.program.kv[this.key];
  }
  static for(program: any, key: string) {
    return new IndexPointer(program, "0x").keyword(key);
  }
  select(k: string) {
    return new IndexPointer(this.program, this.key + stripHexPrefix(k));
  }
  keyword(k: string) {
    return this.select(Buffer.from(k).toString("hex"));
  }
  getUInt64(): BigInt {
    return BigInt(
      "0x" +
        chunk([].slice.call(stripHexPrefix(this.get())), 2)
          .map((v) => v.join(""))
          .reverse()
          .join("")
    );
  }
  getBST(): any {
    return Object.entries(this.program.kv)
      .filter(
        ([k, v]) =>
          k.substr(0, this.key.length) === this.key &&
          k.substr(k.length - 10, 10) !== "2f6d61736b"
      )
      .reduce((r, [k, v]: any) => {
        r[addHexPrefix(k.substr(2 + this.key.length))] = v;
        return r;
      }, {});
  }
}

export class IndexerProgram extends EventEmitter {
  public block: string;
  public program: ArrayBuffer;
  public kv: any;
  public blockHeight: number;
  constructor(program: ArrayBuffer) {
    super();
    this.program = program;
    this.kv = {};
  }
  get memory() {
    return (this as any).instance.instance.exports.memory;
  }
  getStringFromPtr(ptr: number): string {
    const ary = Array.from(new Uint8Array(this.memory.buffer));
    const data = Buffer.from(ary);
    const length = data.readUInt32LE(ptr - 4);
    return Buffer.from(ary.slice(ptr, ptr + length)).toString("utf8");
  }
  __log(ptr: number): void {
    this.emit("log", this.getStringFromPtr(ptr));
  }
  __load_input(ptr: number): void {
    const view = new Uint8Array(this.memory.buffer);
    const block = Buffer.concat([
      toU32LEBytes(this.blockHeight),
      Buffer.from(stripHexPrefix(this.block), "hex"),
    ]);
    for (let i = 0; i < block.length; i++) {
      view[i + ptr] = block.readUInt8(i);
    }
  }
  __host_len(): number {
    return 4 + stripHexPrefix(this.block).length / 2;
  }
  __flush(v: number): void {
    const data = readArrayBufferAsHex(this.memory, v);
    const list = fromKeyValueFlush(data);
    chunk(list, 2).forEach(([key, value]: any) => {
      this.kv[key] = value;
    });
  }
  __get(k: number, v: number): void {
    const key = readArrayBufferAsHex(this.memory, k);
    const value = this.kv[key] || "0x";
    this.emit("get", [key, value]);
    const view = new Uint8Array(this.memory.buffer);
    const valueData = Buffer.from(stripHexPrefix(value), "hex");
    for (let i = 0; i < valueData.length; i++) {
      view[v + i] = valueData.readUInt8(i);
    }
  }
  __get_len(k: number): number {
    const key = readArrayBufferAsHex(this.memory, k);
    if (!this.kv[key]) return 0;
    return stripHexPrefix(this.kv[key]).length / 2;
  }
  abort(msgPtr: number) {
    const msg = this.getStringFromPtr(msgPtr);
    this.emit(`abort: ${msg}`);
    throw Error(`abort: ${msg}`);
  }
  setBlock(block: string): IndexerProgram {
    this.block = block;
    return this;
  }
  setBlockHeight(blockHeight: number): IndexerProgram {
    this.blockHeight = blockHeight;
    return this;
  }
  async run(symbol: string) {
    (this as any).instance = await WebAssembly.instantiate(this.program, {
      env: {
        abort: (...args) => (this as any).abort(...args),
        __log: (...args) => (this as any).__log(...args),
        __flush: (...args) => (this as any).__flush(...args),
        __get: (...args) => (this as any).__get(...args),
        __get_len: (...args) => (this as any).__get_len(...args),
        __host_len: () => (this as any).__host_len(),
        __load_input: (ptr: number) => (this as any).__load_input(ptr),
      },
    });
    return await (this as any).instance.instance.exports[symbol]();
  }
}
