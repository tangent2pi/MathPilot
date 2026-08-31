# src/packages/contracts — 契约包

本包是 JSON Schema 的唯一契约源（ADR-003）。

## 目录结构

```text
src/packages/contracts/
  schemas/
    science-v3/  科学内核、题级流、Dream、Runtime 与前端读模型的 Next 权威契约
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
    validate_examples.py       样例契约测试（valid/valid_cases 必须过，missing/rejected 必须拒）
    science_v3_permissions.py  Next 权限、写权威、身份分离和无旧 mode 不变量
```

## 规则

1. `$id` 使用合法 URI `https://schemas.mathpilot.dev/<group>/<name>/v<major>`；对每个 major 版本不可变。业务协议标识（如 `mathpilot.learning-artifact/v1`、`mathpilot.question-card/v1` 的 const 值）保持设计文档原命名，不是 `$id`。
2. 每个 schema 必须：
   - `$description` 注明生产者（written-by）与消费者（read-by）；
   - 同目录 `*.examples.json` 至少含 `valid` / `missing_field`，Next 契约用 `valid_cases` / `rejected` 覆盖正反例；
   - 需要跨模块引用时用 `$ref` 指向 `mathpilot.common/…`，禁止复制字段。
3. 所有样例与 schema 的校验测试位于 `src/packages/contracts/test/`，`pnpm contracts:validate` 必须全绿。
4. OpenAPI / ui-sdk 生成类型（设计 §2.4 `packages/ui-sdk`）在阶段 B 从本目录生成，禁止手写生成物（ADR-003）。

## Next 科学内核 v3

`schemas/science-v3/` 是科学内核与 Dream 封版 v3 的唯一新写路径契约。它使用独立
`ConversationThreadId`、`ForegroundEpochId`、`QuestionSessionId`、`WorkflowId` 与
`AgentAttemptId`，不复用旧 `session_id/mode/run/PUD` 语义。其命令联合中不存在直接写
M/R/C_e、FSRS Card 或编辑 Annotation 的动作；`DomainUIPart` 只接受
`origin=domain_projector`；学习 TaskSpec 不表达 Bash、SQL、任意网络或凭据能力。

下面的 `learning/`、`profile/` 首批冻结清单属于旧实现协议，只服务尚未退役的旧路径；
Next 服务不得新增引用。完成 v3 切换后按 GOAL 的 Removal gate 删除或只读归档，而不是
建立兼容转换或双写。

## 旧首批冻结清单（实施规划 v1 §11）

1. `common/identity`　2. `common/provenance`　3. `content/source-document`　4. `content/question`　5. `content/chapter-package`　6. `learning/question-session`　7. `learning/answer-judgment`　8. `learning/state-observation`　9. `learning/teaching-message`　10. `learning/learning-artifact-manifest`　11. `learning/question-card`　12. `learning/artifact-response`　13. `learning/card-response`　14. `profile/scientific-evaluation-report`　15. `profile/teaching-session-summary`　16. `profile/session-learning-record`　17. `profile/profile-evidence-bundle`　18. `profile/profile-update-decision`　19. `profile/profile-decision-validation`　20. `profile/student-snapshot`　21. `review/teacher-correction`　22. `providers/provider-trace`

不变量：未发布文件、越界路径、无来源语义字段、越权引用在任何阶段都必须被拒绝。
