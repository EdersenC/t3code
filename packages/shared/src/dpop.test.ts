import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  normalizeDpopHtuOption,
  type DpopPublicJwk,
  verifyDpopProof,
} from "./dpop.ts";

function signDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk | (DpopPublicJwk & { readonly d: string });
  readonly accessToken?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("verifyDpopProof", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proof = signDpopProof({
    method: "POST",
    url: "https://example.com/oauth/token",
    iat: 100,
    privateKey,
    publicJwk,
  });

  it("verifies an ES256 DPoP proof and returns the RFC 7638 thumbprint", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const result = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
    });
    assert.isTrue(result.ok);
    if (result.ok) {
      assert.equal(result.thumbprint, thumbprint);
      assert.equal(result.jti, "proof-1");
    }
  });

  it("rejects method, URL, thumbprint, and time-window mismatches", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    assert.isFalse(
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
    );
    assert.isFalse(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/other",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
    );
    assert.isFalse(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: "other-thumbprint",
      }).ok,
    );
    assert.isFalse(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        expectedThumbprint: thumbprint,
      }).ok,
    );
  });

  it("requires the RFC 9449 access token hash when an access token is expected", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const accessTokenProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
      accessToken: "clerk-access-token",
    });

    assert.isTrue(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }).ok,
    );
    const missingAth = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
      expectedAccessToken: "clerk-access-token",
    });
    assert.isFalse(missingAth.ok);
    if (!missingAth.ok) {
      assert.equal(missingAth.reason, "DPoP access token hash mismatch.");
    }
    const mismatchedAth = verifyDpopProof({
      proof: accessTokenProof,
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
      expectedAccessToken: "other-access-token",
    });
    assert.isFalse(mismatchedAth.ok);
    if (!mismatchedAth.ok) {
      assert.equal(mismatchedAth.reason, "DPoP access token hash mismatch.");
    }
  });

  it("normalizes htu by excluding query and fragment components per RFC 9449", () => {
    const normalized = normalizeDpopHtuOption(
      "https://example.com/v1/environments/env/connect?foo=bar#frag",
    );
    assert.isTrue(Option.isSome(normalized));
    assert.equal(
      Option.getOrThrow(normalized),
      "https://example.com/v1/environments/env/connect",
    );
    assert.equal(
      normalizeDpopHtu("https://example.com/v1/environments/env/connect?foo=bar#frag"),
      "https://example.com/v1/environments/env/connect",
    );

    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const queryProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
    });

    assert.isTrue(
      verifyDpopProof({
        proof: queryProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect?foo=bar#frag",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }).ok,
    );
  });

  it("rejects DPoP public JWK headers that expose private key material", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const privateJwk = privateKey.export({ format: "jwk" }) as DpopPublicJwk & {
      readonly d: string;
    };
    const proofWithPrivateJwk = signDpopProof({
      method: "POST",
      url: "https://example.com/oauth/token",
      iat: 100,
      privateKey,
      publicJwk: privateJwk,
    });

    const result = verifyDpopProof({
      proof: proofWithPrivateJwk,
      method: "POST",
      url: "https://example.com/oauth/token",
      nowEpochSeconds: 101,
      expectedThumbprint: thumbprint,
    });
    assert.isFalse(result.ok);
    if (!result.ok) {
      assert.equal(result.reason, "Invalid DPoP JWT header.");
    }
  });
});
