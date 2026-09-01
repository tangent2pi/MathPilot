import assert from "node:assert/strict";
import test from "node:test";
import type { ImmutableObjectDescriptor } from "@mathpilot/content-integrity";
import { contentLibraryResponseBody } from "../extensions/content-library.ts";
import {
  candidateRegistrationDisposition,
  candidateRegistrationResponseBody,
} from "../extensions/respond.ts";

const digest = "a".repeat(64);
const descriptor = (objectId: string): ImmutableObjectDescriptor => ({
  object_id: objectId,
  object_ref: `storage-object:${objectId}`,
  version_id: `version-${objectId}`,
  sha256: digest,
  byte_size: 1,
  mime_type: "application/json",
  original_name: `${objectId}.json`,
  source: {
    version_id: `source-${objectId}`,
    sha256: digest,
    byte_size: 1,
    mime_type: "application/json",
  },
  expires_at: null,
});

const audits = [descriptor("obj_result01"), descriptor("obj_receipt01")] as const;

test("candidate registration claims only the exact audit pair reported by Content", () => {
  assert.deepEqual(candidateRegistrationDisposition({ registration: {
    created: true,
    result_object_id: audits[0].object_id,
    receipt_object_id: audits[1].object_id,
    result_sha256: digest,
  } }, audits, digest), { claimed: true, replayed: false });

  assert.deepEqual(candidateRegistrationDisposition({ registration: {
    created: false,
    result_object_id: "obj_previous1",
    receipt_object_id: "obj_previous2",
    result_sha256: digest,
  } }, audits, digest), { claimed: false, replayed: true });
});

test("candidate registration rejects an inconsistent create receipt", () => {
  assert.throws(() => candidateRegistrationDisposition({ registration: {
    created: true,
    result_object_id: "obj_different1",
    receipt_object_id: "obj_different2",
    result_sha256: digest,
  } }, audits, digest), /claimed different audit objects/);
});

const problemResponse = (status: number, body: Record<string,unknown>, mediaType = "application/problem+json") =>
  new Response(JSON.stringify(body),{ status,headers:{ "content-type":mediaType } });

test("Content library failures use only canonical public Problem diagnostics", async () => {
  await assert.rejects(contentLibraryResponseBody(problemResponse(422,{
    type:"urn:mathpilot:problem:invalid-library-query",
    title:"Invalid library query",
    status:422,
    code:"invalid_library_query",
    detail:"Query must be shorter",
  })),/Query must be shorter/);
  await assert.rejects(contentLibraryResponseBody(problemResponse(500,{
    type:"urn:mathpilot:problem:content-library-failed",
    title:"Content library request failed",
    status:500,
    code:"content_library_failed",
    detail:"secret SQL token /srv/private",
  })),(error: unknown) => error instanceof Error
    && error.message==="Content library request failed"
    && !/secret|SQL|token|private/.test(error.message));
  await assert.rejects(contentLibraryResponseBody(problemResponse(502,{
    error:"secret upstream path /srv/private",
  },"application/json")),(error: unknown) => error instanceof Error
    && !/secret|path|private/.test(error.message));
  await assert.rejects(contentLibraryResponseBody(new Response("not-json",{
    status:200,headers:{ "content-type":"application/json" },
  })),SyntaxError);
});

test("candidate registration rejects malformed and server Problem detail without leaking it", async () => {
  await assert.rejects(candidateRegistrationResponseBody(problemResponse(500,{
    type:"urn:mathpilot:problem:candidate-registration-failed",
    title:"Candidate registration failed",
    status:500,
    code:"candidate_registration_failed",
    detail:"secret database token /srv/private",
  })),(error: unknown) => error instanceof Error
    && /Candidate registration failed/.test(error.message)
    && !/secret|database|token|private/.test(error.message));
  await assert.rejects(candidateRegistrationResponseBody(problemResponse(502,{
    detail:"secret legacy detail",
    error:"secret legacy error",
  },"application/json")),(error: unknown) => error instanceof Error
    && !/secret|legacy/.test(error.message));
  await assert.rejects(candidateRegistrationResponseBody(new Response("not-json",{
    status:200,headers:{ "content-type":"application/json" },
  })),SyntaxError);
});
