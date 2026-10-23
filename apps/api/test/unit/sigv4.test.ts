import { describe, expect, it } from "vitest";
import { amzDate, sha256Hex, signS3Request, uriEncode } from "../../src/export/sigv4.js";

// The worked examples from the S3 documentation ("Examples: Signature Calculations").
const creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  date: new Date("2013-05-24T00:00:00Z"),
};

describe("AWS Signature Version 4 for S3", () => {
  it("reproduces the documented GET Object signature", () => {
    const headers = signS3Request({
      ...creds,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: sha256Hex(""),
    });
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("reproduces the documented PUT Object signature, encoding the key", () => {
    const body = "Welcome to Amazon S3.";
    const headers = signS3Request({
      ...creds,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: sha256Hex(body),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("signs the session token and query string when present", () => {
    const headers = signS3Request({
      ...creds,
      sessionToken: "token-123",
      method: "GET",
      url: new URL("https://s3.us-east-1.amazonaws.com/bucket/?list-type=2&prefix=a%20b"),
      headers: {},
      payloadHash: sha256Hex(""),
    });
    expect(headers["x-amz-security-token"]).toBe("token-123");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,",
    );
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("encodes like RFC 3986 and formats timestamps without separators", () => {
    expect(uriEncode("a b/c*d(e)!'")).toBe("a%20b%2Fc%2Ad%28e%29%21%27");
    expect(uriEncode("trc_1.json-~")).toBe("trc_1.json-~");
    expect(amzDate(new Date("2026-10-23T07:08:09.123Z"))).toBe("20261023T070809Z");
  });
});
