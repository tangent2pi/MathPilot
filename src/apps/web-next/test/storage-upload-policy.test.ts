import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import { CONTENT_POLICIES } from "@mathpilot/content-integrity";
import type Uppy from "@uppy/core";
import { storageObjectResolveBody } from "../src/hooks/use-storage-object-url.ts";
import {
  runUppyObjectUpload,
  storageUploadDeclaration,
  storageUploadFileTypes,
  storageUploadRestrictions,
} from "../src/storage-upload.ts";

test("an allowed extension supplies a bounded MIME when the browser leaves File.type empty", () => {
  const declaration = storageUploadDeclaration(new File(["# 数学"], "notes.md"), "thread");
  assert.equal(declaration.mime_type, "text/markdown");
  assert.equal(declaration.byte_size, 8);

  assert.equal(
    storageUploadDeclaration(new File(["{}"], "evidence.json"), "candidate").mime_type,
    "application/json",
  );
  assert.equal(
    storageUploadDeclaration(new File(["BM"], "diagram.bmp"), "thread").mime_type,
    "image/bmp",
  );
  assert.equal(
    storageUploadDeclaration(
      new File(["{}"], "generic.json", { type: "application/octet-stream" }),
      "candidate",
    ).mime_type,
    "application/json",
  );
});

test("browser upload validation rejects unsupported and oversized files before Uppy starts", () => {
  const restrictions = storageUploadRestrictions("avatar");
  assert.equal(restrictions.maxFileSize, CONTENT_POLICIES.avatar.maximumSourceBytes);
  assert.notEqual(restrictions.maxFileSize, 1);
  assert.ok(restrictions.allowedFileTypes.includes("image/png"));
  assert.deepEqual(storageUploadFileTypes("avatar"), CONTENT_POLICIES.avatar.allowedMimeTypes);
  assert.throws(
    () => storageUploadDeclaration(new File(["x"], "program.exe"), "thread"),
    /不支持这种文件类型/,
  );
  assert.throws(
    () => storageUploadDeclaration(new File([new Uint8Array(1_572_865)], "avatar.png", { type: "image/png" }), "avatar"),
    /1\.5 MiB/,
  );
});

test("the Web resolver carries explicit render intent and rejects malformed references", () => {
  assert.deepEqual(storageObjectResolveBody("storage-object:obj_image001", "inline"), {
    object_refs: ["storage-object:obj_image001"],
    download_intent: "inline",
  });
  assert.equal(storageObjectResolveBody("https://example.test/file", "attachment"), undefined);
});

test("an abort racing listener installation cannot enqueue a later Uppy upload", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal,"addEventListener",{
    value(...args: Parameters<AbortSignal["addEventListener"]>) {
      originalAddEventListener(...args);
      controller.abort();
    },
  });
  const uppy = {
    cancelAll() { events.push("cancel"); },
    on() { return uppy; },
    addFile() { events.push("add"); },
    async upload() { events.push("upload"); return { failed:[],successful:[{}] }; },
    destroy() { events.push("destroy"); },
  } as unknown as Uppy;

  await assert.rejects(
    runUppyObjectUpload(uppy,new File(["x"],"avatar.png"),"image/png",controller.signal),
    (error: unknown) => error instanceof DOMException && error.name==="AbortError",
  );
  assert.deepEqual(events,["cancel","destroy"]);
});

test("an Uppy cancellation failure is reported as AbortError", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const uppy = {
    cancelAll() { events.push("cancel"); },
    on() { return uppy; },
    addFile() { events.push("add"); },
    async upload() {
      controller.abort();
      throw new Error("direct object upload failed");
    },
    destroy() { events.push("destroy"); },
  } as unknown as Uppy;

  await assert.rejects(
    runUppyObjectUpload(uppy,new File(["x"],"avatar.png"),"image/png",controller.signal),
    (error: unknown) => error instanceof DOMException && error.name==="AbortError",
  );
  assert.deepEqual(events,["add","cancel","destroy"]);
});
