import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

class ScryptHelper {
  static const int minN = 1024;
  static const int maxN = 65536;
  static const int minR = 1;
  static const int maxR = 16;
  static const int minP = 1;
  static const int maxP = 4;
  static const int minDkLen = 16;
  static const int maxDkLen = 64;
  static const int maxCost = 65536 * 8;

  static void validateScryptParams({
    required int n,
    required int r,
    required int p,
    required int dkLen,
  }) {
    if (n < minN || n > maxN || (n & (n - 1)) != 0) {
      throw ArgumentError.value(
        n,
        'n',
        'scrypt N must be a power of 2 between $minN and $maxN',
      );
    }
    if (r < minR || r > maxR) {
      throw ArgumentError.value(r, 'r', 'scrypt r must be between $minR and $maxR');
    }
    if (p < minP || p > maxP) {
      throw ArgumentError.value(p, 'p', 'scrypt p must be between $minP and $maxP');
    }
    if (dkLen < minDkLen || dkLen > maxDkLen) {
      throw ArgumentError.value(
        dkLen,
        'dkLen',
        'scrypt dkLen must be between $minDkLen and $maxDkLen',
      );
    }
    if (n * r * p > maxCost) {
      throw ArgumentError('scrypt work factor n * r * p (${n * r * p}) exceeds limit $maxCost');
    }
  }

  static const List<int> _sha256K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  static int _rotr(int x, int n) {
    final ux = x & 0xffffffff;
    return ((ux >> n) | (ux << (32 - n))) & 0xffffffff;
  }

  static int _rotl(int x, int n) {
    final ux = x & 0xffffffff;
    return ((ux << n) | (ux >> (32 - n))) & 0xffffffff;
  }

  static Uint8List sha256(Uint8List data) {
    final bitLen = data.length * 8;
    final rem = (data.length + 9) % 64;
    final padLen = rem == 0 ? 0 : 64 - rem;
    final padded = Uint8List(data.length + 1 + padLen + 8);
    padded.setRange(0, data.length, data);
    padded[data.length] = 0x80;
    final lenBd = ByteData.sublistView(padded, padded.length - 8, padded.length);
    lenBd.setUint32(0, (bitLen >> 32) & 0xffffffff, Endian.big);
    lenBd.setUint32(4, bitLen & 0xffffffff, Endian.big);

    int h0 = 0x6a09e667;
    int h1 = 0xbb67ae85;
    int h2 = 0x3c6ef372;
    int h3 = 0xa54ff53a;
    int h4 = 0x510e527f;
    int h5 = 0x9b05688c;
    int h6 = 0x1f83d9ab;
    int h7 = 0x5be0cd19;

    final w = Uint32List(64);
    final bd = ByteData.sublistView(padded);

    for (int offset = 0; offset < padded.length; offset += 64) {
      for (int i = 0; i < 16; i++) {
        w[i] = bd.getUint32(offset + i * 4, Endian.big);
      }
      for (int i = 16; i < 64; i++) {
        final s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        final s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
      }

      int a = h0;
      int b = h1;
      int c = h2;
      int d = h3;
      int e = h4;
      int f = h5;
      int g = h6;
      int h = h7;

      for (int i = 0; i < 64; i++) {
        final s1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
        final ch = (e & f) ^ ((~e & 0xffffffff) & g);
        final temp1 = (h + s1 + ch + _sha256K[i] + w[i]) & 0xffffffff;
        final s0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
        final maj = (a & b) ^ (a & c) ^ (b & c);
        final temp2 = (s0 + maj) & 0xffffffff;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) & 0xffffffff;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) & 0xffffffff;
      }

      h0 = (h0 + a) & 0xffffffff;
      h1 = (h1 + b) & 0xffffffff;
      h2 = (h2 + c) & 0xffffffff;
      h3 = (h3 + d) & 0xffffffff;
      h4 = (h4 + e) & 0xffffffff;
      h5 = (h5 + f) & 0xffffffff;
      h6 = (h6 + g) & 0xffffffff;
      h7 = (h7 + h) & 0xffffffff;
    }

    final out = Uint8List(32);
    final outBd = ByteData.sublistView(out);
    outBd.setUint32(0, h0, Endian.big);
    outBd.setUint32(4, h1, Endian.big);
    outBd.setUint32(8, h2, Endian.big);
    outBd.setUint32(12, h3, Endian.big);
    outBd.setUint32(16, h4, Endian.big);
    outBd.setUint32(20, h5, Endian.big);
    outBd.setUint32(24, h6, Endian.big);
    outBd.setUint32(28, h7, Endian.big);
    return out;
  }

  static Uint8List hmacSha256(Uint8List key, Uint8List data) {
    const blockSize = 64;
    final normKey = key.length > blockSize ? sha256(key) : key;
    final ipad = Uint8List(blockSize + data.length);
    final opad = Uint8List(blockSize + 32);
    for (int i = 0; i < blockSize; i++) {
      final kb = i < normKey.length ? normKey[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    ipad.setRange(blockSize, ipad.length, data);
    final inner = sha256(ipad);
    opad.setRange(blockSize, opad.length, inner);
    return sha256(opad);
  }

  static Uint8List pbkdf2HmacSha256(
    Uint8List password,
    Uint8List salt,
    int iterations,
    int dkLen,
  ) {
    final out = Uint8List(dkLen);
    final blockInput = Uint8List(salt.length + 4);
    blockInput.setRange(0, salt.length, salt);
    final blockBd = ByteData.sublistView(blockInput, salt.length, salt.length + 4);

    int offset = 0;
    int blockIndex = 1;
    while (offset < dkLen) {
      blockBd.setUint32(0, blockIndex, Endian.big);
      var u = hmacSha256(password, blockInput);
      final t = Uint8List.fromList(u);
      for (int i = 1; i < iterations; i++) {
        u = hmacSha256(password, u);
        for (int j = 0; j < t.length; j++) {
          t[j] ^= u[j];
        }
      }
      final take = (dkLen - offset) < t.length ? (dkLen - offset) : t.length;
      out.setRange(offset, offset + take, t);
      offset += take;
      blockIndex += 1;
    }
    return out;
  }

  static void _salsa208(Uint32List b, Uint32List x) {
    x.setAll(0, b);
    for (int i = 0; i < 4; i++) {
      x[4] ^= _rotl((x[0] + x[12]) & 0xffffffff, 7);
      x[8] ^= _rotl((x[4] + x[0]) & 0xffffffff, 9);
      x[12] ^= _rotl((x[8] + x[4]) & 0xffffffff, 13);
      x[0] ^= _rotl((x[12] + x[8]) & 0xffffffff, 18);

      x[9] ^= _rotl((x[5] + x[1]) & 0xffffffff, 7);
      x[13] ^= _rotl((x[9] + x[5]) & 0xffffffff, 9);
      x[1] ^= _rotl((x[13] + x[9]) & 0xffffffff, 13);
      x[5] ^= _rotl((x[1] + x[13]) & 0xffffffff, 18);

      x[14] ^= _rotl((x[10] + x[6]) & 0xffffffff, 7);
      x[2] ^= _rotl((x[14] + x[10]) & 0xffffffff, 9);
      x[6] ^= _rotl((x[2] + x[14]) & 0xffffffff, 13);
      x[10] ^= _rotl((x[6] + x[2]) & 0xffffffff, 18);

      x[3] ^= _rotl((x[15] + x[11]) & 0xffffffff, 7);
      x[7] ^= _rotl((x[3] + x[15]) & 0xffffffff, 9);
      x[11] ^= _rotl((x[7] + x[3]) & 0xffffffff, 13);
      x[15] ^= _rotl((x[11] + x[7]) & 0xffffffff, 18);

      x[1] ^= _rotl((x[0] + x[3]) & 0xffffffff, 7);
      x[2] ^= _rotl((x[1] + x[0]) & 0xffffffff, 9);
      x[3] ^= _rotl((x[2] + x[1]) & 0xffffffff, 13);
      x[0] ^= _rotl((x[3] + x[2]) & 0xffffffff, 18);

      x[6] ^= _rotl((x[5] + x[4]) & 0xffffffff, 7);
      x[7] ^= _rotl((x[6] + x[5]) & 0xffffffff, 9);
      x[4] ^= _rotl((x[7] + x[6]) & 0xffffffff, 13);
      x[5] ^= _rotl((x[4] + x[7]) & 0xffffffff, 18);

      x[11] ^= _rotl((x[10] + x[9]) & 0xffffffff, 7);
      x[8] ^= _rotl((x[11] + x[10]) & 0xffffffff, 9);
      x[9] ^= _rotl((x[8] + x[11]) & 0xffffffff, 13);
      x[10] ^= _rotl((x[9] + x[8]) & 0xffffffff, 18);

      x[12] ^= _rotl((x[15] + x[14]) & 0xffffffff, 7);
      x[13] ^= _rotl((x[12] + x[15]) & 0xffffffff, 9);
      x[14] ^= _rotl((x[13] + x[12]) & 0xffffffff, 13);
      x[15] ^= _rotl((x[14] + x[13]) & 0xffffffff, 18);
    }
    for (int i = 0; i < 16; i++) {
      b[i] = (b[i] + x[i]) & 0xffffffff;
    }
  }

  static void _blockMix(Uint32List b, int r, Uint32List y, Uint32List x, Uint32List scratch) {
    final lastOff = (2 * r - 1) * 16;
    for (int j = 0; j < 16; j++) {
      x[j] = b[lastOff + j];
    }
    for (int i = 0; i < 2 * r; i++) {
      final bOff = i * 16;
      for (int j = 0; j < 16; j++) {
        x[j] ^= b[bOff + j];
      }
      _salsa208(x, scratch);
      final destBlock = (i.isEven ? (i ~/ 2) : (r + (i ~/ 2))) * 16;
      for (int j = 0; j < 16; j++) {
        y[destBlock + j] = x[j];
      }
    }
    b.setAll(0, y);
  }

  static void _roMix(Uint8List blockBytes, int n, int r) {
    final wordsPerBlock = 32 * r;
    final x = Uint32List(wordsPerBlock);
    final bd = ByteData.sublistView(blockBytes);
    for (int i = 0; i < wordsPerBlock; i++) {
      x[i] = bd.getUint32(i * 4, Endian.little);
    }

    final v = Uint32List(n * wordsPerBlock);
    final y = Uint32List(wordsPerBlock);
    final x16 = Uint32List(16);
    final scratch = Uint32List(16);
    final nMask = n - 1;
    final intWordIdx = (2 * r - 1) * 16;

    for (int i = 0; i < n; i++) {
      v.setRange(i * wordsPerBlock, (i + 1) * wordsPerBlock, x);
      _blockMix(x, r, y, x16, scratch);
    }
    for (int i = 0; i < n; i++) {
      final j = x[intWordIdx] & nMask;
      final vOff = j * wordsPerBlock;
      for (int k = 0; k < wordsPerBlock; k++) {
        x[k] ^= v[vOff + k];
      }
      _blockMix(x, r, y, x16, scratch);
    }

    for (int i = 0; i < wordsPerBlock; i++) {
      bd.setUint32(i * 4, x[i], Endian.little);
    }
  }

  static Uint8List scrypt(
    Uint8List password,
    Uint8List salt, {
    int n = 16384,
    int r = 8,
    int p = 1,
    int dkLen = 32,
  }) {
    validateScryptParams(n: n, r: r, p: p, dkLen: dkLen);
    final blockBytesLen = 128 * r;
    final b = pbkdf2HmacSha256(password, salt, 1, p * blockBytesLen);
    for (int i = 0; i < p; i++) {
      final slice = Uint8List.sublistView(b, i * blockBytesLen, (i + 1) * blockBytesLen);
      _roMix(slice, n, r);
    }
    return pbkdf2HmacSha256(password, b, 1, dkLen);
  }

  static Uint8List hexToBytes(String hex) {
    final clean = hex.trim();
    final out = Uint8List(clean.length ~/ 2);
    for (int i = 0; i < out.length; i++) {
      out[i] = int.parse(clean.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  static String bytesToHex(Uint8List bytes) {
    final sb = StringBuffer();
    for (final b in bytes) {
      sb.write(b.toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }

  static String computeChallengeProofSync({
    required String password,
    required String saltHex,
    required String hostId,
    required String challengeId,
    required String nonce,
    int n = 16384,
    int r = 8,
    int p = 1,
    int dkLen = 32,
  }) {
    validateScryptParams(n: n, r: r, p: p, dkLen: dkLen);
    final pwBytes = Uint8List.fromList(utf8.encode(password));
    final saltBytes = hexToBytes(saltHex);
    final dk = scrypt(pwBytes, saltBytes, n: n, r: r, p: p, dkLen: dkLen);
    final msgBytes = Uint8List.fromList(utf8.encode('airdesk-pw-v1:$hostId:$challengeId:$nonce'));
    return bytesToHex(hmacSha256(dk, msgBytes));
  }

  static Future<String> computeChallengeProofAsync({
    required String password,
    required String saltHex,
    required String hostId,
    required String challengeId,
    required String nonce,
    int n = 16384,
    int r = 8,
    int p = 1,
    int dkLen = 32,
  }) async {
    validateScryptParams(n: n, r: r, p: p, dkLen: dkLen);
    return Isolate.run(
      () => computeChallengeProofSync(
        password: password,
        saltHex: saltHex,
        hostId: hostId,
        challengeId: challengeId,
        nonce: nonce,
        n: n,
        r: r,
        p: p,
        dkLen: dkLen,
      ),
    );
  }
}
