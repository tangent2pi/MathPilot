/**
 * artifact-service 骨架：ArtifactPublisher 的最小发布校验。
 * 已实现的硬规则（设计 §5.4）：固定文件名白名单、路径逃逸/符号链接拒绝、
 * response_policy.required 必须为 false。HTML 清洗/媒体转码在 WP-07 落地。
 */
import { startService, newId } from "@agmath/service-kit";

const ALLOWED_PATH = /^(index\.html|card\.json|content\.md|manifest\.json|media\/[A-Za-z0-9._-]+)$/;

interface PublishBody {
  sessionId: string;
  artifactId: string;
  manifest: {
    schema?: string;
    response_policy?: { required?: boolean; allow_skip?: boolean; allow_free_text_without_answer?: boolean };
    files?: { path: string; mimeType?: string; contentHash?: string }[];
  };
}

startService({
  name: "artifact",
  port: Number(process.env.PORT ?? 3007),
  register(app) {
    app.post("/artifacts/publish", async (req, reply) => {
      const body = req.body as PublishBody;
      const m = body.manifest;
      if (m?.schema !== "agmath.learning-artifact/v1") {
        return reply.code(422).send({ ok: false, rejection: "invalid_manifest" });
      }
      if (m.response_policy?.required !== false) {
        return reply.code(422).send({ ok: false, rejection: "invalid_manifest", detail: "required must be false" });
      }
      for (const f of m.files ?? []) {
        if (f.path.includes("..") || f.path.startsWith("/") || !ALLOWED_PATH.test(f.path)) {
          return reply.code(422).send({ ok: false, rejection: "path_escape", detail: f.path });
        }
      }
      return {
        ok: true,
        value: {
          artifactUri: `artifact://${body.sessionId}/${body.artifactId}`,
          artifactVersionId: newId("artv"),
          note: "skeleton publish: 未做 HTML 清洗/媒体转码（WP-07）",
        },
      };
    });
  },
});
