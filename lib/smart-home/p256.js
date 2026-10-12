// Just enough P-256 (NIST secp256r1) arithmetic for the SPAKE2+ login in tpap.js. Node's crypto
// module does ECDH but not the point additions and multiplications SPAKE2+ needs.
// Points are { x, y } BigInts, or null for the point at infinity.
// Part of the port of the Rust `tapo` crate's TPAP login, Copyright (c) 2022-2025 Mihai Dinculescu,
// MIT License (see LICENSE).

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const G = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

const mod = (a, m = P) => ((a % m) + m) % m;

function powMod(base, exp, m = P) {
    let result = 1n;
    base = mod(base, m);
    while (exp > 0n) {
        if (exp & 1n) result = result * base % m;
        base = base * base % m;
        exp >>= 1n;
    }
    return result;
}

const inv = a => powMod(a, P - 2n);

export function add(p, q) {
    if (!p) return q;
    if (!q) return p;
    if (p.x === q.x) {
        if (mod(p.y + q.y) === 0n) return null;
        return double(p);
    }
    const l = mod((q.y - p.y) * inv(q.x - p.x));
    const x = mod(l * l - p.x - q.x);
    return { x, y: mod(l * (p.x - x) - p.y) };
}

function double(p) {
    if (!p || p.y === 0n) return null;
    const l = mod((3n * p.x * p.x - 3n) * inv(2n * p.y));
    const x = mod(l * l - 2n * p.x);
    return { x, y: mod(l * (p.x - x) - p.y) };
}

export const negate = p => p && { x: p.x, y: mod(-p.y) };

export function multiply(p, k) {
    k = mod(k, ORDER);
    let result = null;
    for (let addend = p; k > 0n; k >>= 1n, addend = double(addend)) {
        if (k & 1n) result = add(result, addend);
    }
    return result;
}

const curveY2 = x => mod(x * x * x - 3n * x + B);

export const bytesToBig = buf => buf.length ? BigInt('0x' + Buffer.from(buf).toString('hex')) : 0n;
export const bigToBytes = (n, len = 32) => Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex');

// A SEC1 point, compressed (02/03 + x) or uncompressed (04 + x + y); null if it isn't on the curve.
export function decode(buf) {
    buf = Buffer.from(buf);
    if (buf.length === 65 && buf[0] === 4) {
        const x = bytesToBig(buf.subarray(1, 33)), y = bytesToBig(buf.subarray(33));
        return x < P && y < P && mod(y * y) === curveY2(x) ? { x, y } : null;
    }
    if (buf.length === 33 && (buf[0] === 2 || buf[0] === 3)) {
        const x = bytesToBig(buf.subarray(1));
        if (x >= P) return null;
        const y2 = curveY2(x);
        let y = powMod(y2, (P + 1n) / 4n);
        if (mod(y * y) !== y2) return null;
        if (Number(y & 1n) !== (buf[0] & 1)) y = mod(-y);
        return { x, y };
    }
    return null;
}

export const encode = p => Buffer.concat([Buffer.from([4]), bigToBytes(p.x), bigToBytes(p.y)]);
