# src/packages/contracts — 契约包

本包是 JSON Schema 的唯一契约源（ADR-003）。

## 目录结构

```text
src/packages/contracts/
  schemas/
    common/      身份、租户、provenance
    content/     SourceDocument、Question、ChapterPackage …
    learning/    QuestionSession、AnswerJudgment、Artifact …
    profile/     SER、TSS、SLR、PUD、Snapshot …
    review/      TeacherCorrection …
    providers/   ProviderTrace …
  src/
    index.ts     导出 Provider TS 接口（JSON Schema 仍是唯一契约源）
    providers/   model/ocr/search/media/explanation/artifact/sandbox/auth 接口
    errors.ts    Provider 统一错误/结果/trace 语义
  test/
    validate_examples.py  样例契约测试（valid 必须过、missing_field 必须拒）
```

## 规则

1. `$id` 使用合法 URI `https://schemas.mathpilot.dev/<group>/<name>/v<major>`；对每个 major 版本不可变。业务协议标识（如 `mathpilot.learning-artifact/v1`、`mathpilot.question-card/v1` 的 const 值）保持设计文档原命名，不是 `$id`。
2. 每个 schema 必须：
   - `$description` 注明生产者（written-by）与消费者（read-by）；
   - 同目录 `*.examples.json` 含 `valid` / `missing_field` / `invalid_source` 三组样例；
   - 需要跨模块引用时用 `$ref` 指向 `mathpilot.common/…`，禁止复制字段。
3. 所有样例与 schema 的校验测试位于 `src/packages/contracts/test/`，`pnpm contracts:validate` 必须全绿。
4. OpenAPI / ui-sdk 生成类型（设计 §2.4 `packages/ui-sdk`）在阶段 B 从本目录生成，禁止手写生成物（ADR-003）。

## 首批冻结清单（实施规划 v1 §11）

1. `common/identity`　2. `common/provenance`　3. `content/source-document`　4. `content/question`　5. `content/chapter-package`　6. `learning/question-session`　7. `learning/answer-judgment`　8. `learning/state-observation`　9. `learning/teaching-message`　10. `learning/learning-artifact-manifest`　11. `learning/question-card`　12. `learning/artifact-response`　13. `profile/scientific-evaluation-report`　14. `profile/teaching-session-summary`　15. `profile/session-learning-record`　16. `profile/profile-evidence-bundle`　17. `profile/profile-update-decision`　18. `profile/profile-decision-validation`　19. `profile/student-snapshot`　20. `review/teacher-correction`　21. `providers/provider-trace`

不变量：未发布文件、越界路径、无来源语义字段、越权引用在任何阶段都必须被拒绝。