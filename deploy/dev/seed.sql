-- 仅供测试的合成 fixtures（由 deploy/dev/seed_gen.py 生成），不是比赛内容入库路径。
-- 默认 compose 不加载本文件；正式数据库只能由教师资料批次经 OCR -> KTQ -> ER -> 复核 -> 发布生成。
-- 生成：python3 deploy/dev/seed_gen.py > deploy/dev/seed.sql
begin;

do $$
begin
  if not exists (select from pg_roles where rolname = 'mathpilot_app') then
    create role mathpilot_app login password 'mathpilot-app-dev-only';
  end if;
end $$;
grant usage on schema public to mathpilot_app;
grant select, insert, update, delete on all tables in schema public to mathpilot_app;

insert into identity_tenant(tenant_id, name)
values ('tnt_dev00001', 'Dev Tenant') on conflict (tenant_id) do nothing;

insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)
values
  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher,content_reviewer}'),
  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student 01', '{student}'),
  ('usr_student02', 'tnt_dev00001', 'sub-student-02', 'Dev Student 02', '{student}'),
  ('usr_student03', 'tnt_dev00001', 'sub-student-03', 'Dev Student 03', '{student}')
on conflict (user_id) do nothing;

-- 五专题章节（chapter_id 为题目上的字符串键；包按 chapter_id 绑定，P0-5）

-- ── 知识点 K（26 条，5 专题三级结构） ──
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_SINE_RULE', 'tnt_dev00001', '正弦定理', '{"dimension_id": "K_SINE_RULE", "name": "正弦定理", "module": "正余弦定理与基本应用", "mastery_standard": "能在任意三角形中列出并解正弦定理方程", "remedial_advice": "熟记 a/sinA=b/sinB=c/sinC，先找两边两角"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_COSINE_RULE', 'tnt_dev00001', '余弦定理', '{"dimension_id": "K_COSINE_RULE", "name": "余弦定理", "module": "正余弦定理与基本应用", "mastery_standard": "能由两边夹角或三边求第三边/角", "remedial_advice": "记 a²=b²+c²−2bc·cosA，注意符号"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_TRIANGLE_AREA', 'tnt_dev00001', '三角形面积公式', '{"dimension_id": "K_TRIANGLE_AREA", "name": "三角形面积公式", "module": "正余弦定理与基本应用", "mastery_standard": "能用 S=½bc·sinA 计算面积", "remedial_advice": "面积含 ½ 与 sinA，勿漏"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_SHAPE_JUDGE', 'tnt_dev00001', '三角形形状判断', '{"dimension_id": "K_SHAPE_JUDGE", "name": "三角形形状判断", "module": "正余弦定理与基本应用", "mastery_standard": "能由边角关系判断等腰/直角/等边", "remedial_advice": "优先边化角或角化边统一再判断"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_TRIANGLE_EXISTENCE', 'tnt_dev00001', '三角形存在条件', '{"dimension_id": "K_TRIANGLE_EXISTENCE", "name": "三角形存在条件", "module": "正余弦定理与基本应用", "mastery_standard": "能判断给定条件是否构成唯一/两解/无解", "remedial_advice": "SSA 必须讨论补角分支与 A+B<180°"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_MEDIAN', 'tnt_dev00001', '中线长公式', '{"dimension_id": "K_MEDIAN", "name": "中线长公式", "module": "中线角平分线高线", "mastery_standard": "能用 m_a=½√(2b²+2c²−a²) 求中线", "remedial_advice": "中线公式与重心 2:1 分点结合"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_ANGLE_BISECTOR', 'tnt_dev00001', '角平分线', '{"dimension_id": "K_ANGLE_BISECTOR", "name": "角平分线", "module": "中线角平分线高线", "mastery_standard": "能用角平分线定理 BD/DC=AB/AC", "remedial_advice": "角平分线长公式与比例定理分用"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_ALTITUDE', 'tnt_dev00001', '高线', '{"dimension_id": "K_ALTITUDE", "name": "高线", "module": "中线角平分线高线", "mastery_standard": "能用 h=2S/a 与底边对应关系求高", "remedial_advice": "高线对应底边不能张冠李戴"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_ZHANG_ANGLE', 'tnt_dev00001', '张角问题', '{"dimension_id": "K_ZHANG_ANGLE", "name": "张角问题", "module": "中线角平分线高线", "mastery_standard": "能用 tan 关系与和角公式解共顶点角", "remedial_advice": "张角两角之和为定角时列 tan 和角"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_EQUAL_AREA', 'tnt_dev00001', '等面积法', '{"dimension_id": "K_EQUAL_AREA", "name": "等面积法", "module": "中线角平分线高线", "mastery_standard": "能用一个面积两种表达建立方程", "remedial_advice": "同一三角形面积可写成多种底高组合"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_CIRCUMCIRCLE', 'tnt_dev00001', '外接圆', '{"dimension_id": "K_CIRCUMCIRCLE", "name": "外接圆", "module": "圆与多三角形", "mastery_standard": "能用 R=a/(2sinA) 求外接圆半径", "remedial_advice": "直径所对圆周角为直角可简化"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_INCIRCLE', 'tnt_dev00001', '内切圆', '{"dimension_id": "K_INCIRCLE", "name": "内切圆", "module": "圆与多三角形", "mastery_standard": "能用 r=S/s 求内切圆半径", "remedial_advice": "r=S/s，s 为半周长"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_MULTI_TRIANGLE', 'tnt_dev00001', '多三角形拆分', '{"dimension_id": "K_MULTI_TRIANGLE", "name": "多三角形拆分", "module": "圆与多三角形", "mastery_standard": "能把复杂图形拆成若干三角形分析", "remedial_advice": "公共边/公共角是拆分的桥"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_COMMON_EDGE', 'tnt_dev00001', '公共边角转化', '{"dimension_id": "K_COMMON_EDGE", "name": "公共边角转化", "module": "圆与多三角形", "mastery_standard": "能在共边两三角形间转化角与边", "remedial_advice": "互补角正弦相等、同弧圆周角相等"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_RADIUS_RELATION', 'tnt_dev00001', '半径关系', '{"dimension_id": "K_RADIUS_RELATION", "name": "半径关系", "module": "圆与多三角形", "mastery_standard": "能处理 R 与 r 的比例/数量关系", "remedial_advice": "等边三角形 r=R/2，直角三角形 r=(a+b−c)/2"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_ANGLE_TO_SIDE', 'tnt_dev00001', '角化边', '{"dimension_id": "K_ANGLE_TO_SIDE", "name": "角化边", "module": "最值与范围", "mastery_standard": "能把角条件化为边的条件", "remedial_advice": "正弦定理整式化，边化角同理"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_SIDE_TO_ANGLE', 'tnt_dev00001', '边化角', '{"dimension_id": "K_SIDE_TO_ANGLE", "name": "边化角", "module": "最值与范围", "mastery_standard": "能把边条件化为角的条件", "remedial_advice": "边比化为正弦比，注意等价性"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_INEQUALITY', 'tnt_dev00001', '基本不等式', '{"dimension_id": "K_INEQUALITY", "name": "基本不等式", "module": "最值与范围", "mastery_standard": "能用 ab≤((a+b)/2)² 求最值并写取等", "remedial_advice": "取等条件必须可达（三角形约束下）"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_TRIG_RANGE', 'tnt_dev00001', '三角函数值域', '{"dimension_id": "K_TRIG_RANGE", "name": "三角函数值域", "module": "最值与范围", "mastery_standard": "能求 sinA+sinB 等式的范围", "remedial_advice": "和积化积后用 |cos|≤1 夹逼"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_EDGE_RANGE', 'tnt_dev00001', '边长范围', '{"dimension_id": "K_EDGE_RANGE", "name": "边长范围", "module": "最值与范围", "mastery_standard": "能用三角不等式与正弦定理求边范围", "remedial_advice": "退化三角形处取开区间"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_TANGENT_IDENTITY', 'tnt_dev00001', '正切恒等式', '{"dimension_id": "K_TANGENT_IDENTITY", "name": "正切恒等式", "module": "定理与模型", "mastery_standard": "能用 tanA+tanB+tanC=tanA·tanB·tanC", "remedial_advice": "A+B+C=π 时成立，注意分母为零"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_SINE_SQUARE_DIFF', 'tnt_dev00001', '正弦平方差', '{"dimension_id": "K_SINE_SQUARE_DIFF", "name": "正弦平方差", "module": "定理与模型", "mastery_standard": "能用 sin²A−sin²B=sin(A+B)sin(A−B)", "remedial_advice": "平方差公式与和差化积联动"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_POWER_OF_POINT', 'tnt_dev00001', '圆幂定理', '{"dimension_id": "K_POWER_OF_POINT", "name": "圆幂定理", "module": "定理与模型", "mastery_standard": "能用相交弦/割线/切割线定理", "remedial_advice": "切线长平方等于割线两段之积"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_HIDDEN_CIRCLE', 'tnt_dev00001', '隐圆', '{"dimension_id": "K_HIDDEN_CIRCLE", "name": "隐圆", "module": "定理与模型", "mastery_standard": "能从定角/定比识别隐圆轨迹", "remedial_advice": "∠APB 为定角 → P 在定圆弧上"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_APOLLONIUS', 'tnt_dev00001', '阿波罗尼斯圆', '{"dimension_id": "K_APOLLONIUS", "name": "阿波罗尼斯圆", "module": "定理与模型", "mastery_standard": "能由 PA:PB=定值求动点轨迹圆", "remedial_advice": "按比例平方展开配方成圆方程"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_PTOLEMY', 'tnt_dev00001', '托勒密定理', '{"dimension_id": "K_PTOLEMY", "name": "托勒密定理", "module": "定理与模型", "mastery_standard": "能对圆内接四边形用 AC·BD=AB·CD+BC·DA", "remedial_advice": "圆内接四边形对边乘积之和等于对角线乘积"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;

-- ── 题型 T（20 条） ──
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_SSA_SOLVE', 'tnt_dev00001', 'SSA 解三角形', '{"dimension_id": "T_SSA_SOLVE", "name": "SSA 解三角形", "typical_ask": "已知两边一对角求另一对角", "standard_steps": "正弦定理→sinB→讨论解数", "scoring_points": "列出正弦定理；补角分支与存在性"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_SSA_BRANCH', 'tnt_dev00001', 'SSA 两解讨论', '{"dimension_id": "T_SSA_BRANCH", "name": "SSA 两解讨论", "typical_ask": "SSA 条件下判断解的个数并求两解", "standard_steps": "sinB 值→B 的两组可能→验证 A+B<180°", "scoring_points": "求 sinB；逐个验证解的合法性"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_SIDE_SOLVE', 'tnt_dev00001', '已知两边一角求边', '{"dimension_id": "T_SIDE_SOLVE", "name": "已知两边一角求边", "typical_ask": "已知两边及夹角求第三边", "standard_steps": "余弦定理直接代入", "scoring_points": "套用余弦定理；开方取正"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_ANGLE_SOLVE', 'tnt_dev00001', '已知边求角', '{"dimension_id": "T_ANGLE_SOLVE", "name": "已知边求角", "typical_ask": "已知三边求最大角/判定", "standard_steps": "余弦定理求 cos 值", "scoring_points": "选最大边对应角；余弦值定角"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_AREA_COMPUTE', 'tnt_dev00001', '面积计算', '{"dimension_id": "T_AREA_COMPUTE", "name": "面积计算", "typical_ask": "已知两边夹角求面积", "standard_steps": "S=½bc·sinA", "scoring_points": "面积公式代入"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_SHAPE_JUDGE', 'tnt_dev00001', '形状判断', '{"dimension_id": "T_SHAPE_JUDGE", "name": "形状判断", "typical_ask": "由边角关系判断三角形形状", "standard_steps": "统一为边或角→化简", "scoring_points": "化统一；结论完整（等腰/直角/等边）"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_MEDIAN_SOLVE', 'tnt_dev00001', '中线长问题', '{"dimension_id": "T_MEDIAN_SOLVE", "name": "中线长问题", "typical_ask": "已知三边/两边夹角求中线长", "standard_steps": "中线长公式或余弦两次", "scoring_points": "公式代入；结果开方"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_BISECTOR_SOLVE', 'tnt_dev00001', '角平分线问题', '{"dimension_id": "T_BISECTOR_SOLVE", "name": "角平分线问题", "typical_ask": "角平分线分边或求角平分线长", "standard_steps": "比例定理/角平分线长公式", "scoring_points": "比例式；长公式 2bc·cos(A/2)/(b+c)"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_ALTITUDE_SOLVE', 'tnt_dev00001', '高线问题', '{"dimension_id": "T_ALTITUDE_SOLVE", "name": "高线问题", "typical_ask": "求高线长或由高求面积", "standard_steps": "h=2S/a 或三角形拆分", "scoring_points": "底边对应正确"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_EQUAL_AREA', 'tnt_dev00001', '等面积法应用', '{"dimension_id": "T_EQUAL_AREA", "name": "等面积法应用", "typical_ask": "用等面积法建立方程", "standard_steps": "同一面积两种表达", "scoring_points": "两种表达相等；解方程"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_CIRCUMCIRCLE_SOLVE', 'tnt_dev00001', '外接圆半径', '{"dimension_id": "T_CIRCUMCIRCLE_SOLVE", "name": "外接圆半径", "typical_ask": "求外接圆半径/直径", "standard_steps": "R=a/(2sinA)", "scoring_points": "正弦定理比值"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_INCIRCLE_SOLVE', 'tnt_dev00001', '内切圆半径', '{"dimension_id": "T_INCIRCLE_SOLVE", "name": "内切圆半径", "typical_ask": "求内切圆半径", "standard_steps": "r=S/s", "scoring_points": "面积与半周长"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_MULTI_TRIANGLE', 'tnt_dev00001', '多三角形', '{"dimension_id": "T_MULTI_TRIANGLE", "name": "多三角形", "typical_ask": "复杂图形拆分为三角形求量", "standard_steps": "找公共边/公共角拆分", "scoring_points": "拆分完整；无遗漏重叠"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_COMMON_EDGE', 'tnt_dev00001', '公共边角', '{"dimension_id": "T_COMMON_EDGE", "name": "公共边角", "typical_ask": "共边两三角形间转化", "standard_steps": "正弦定理+互补角", "scoring_points": "角关系转化正确"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_MAX_MIN', 'tnt_dev00001', '最值范围', '{"dimension_id": "T_MAX_MIN", "name": "最值范围", "typical_ask": "求边/周长/面积的最值或范围", "standard_steps": "边化角→三角函数范围；或不等式", "scoring_points": "取等条件说明"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_INEQUALITY_APPLY', 'tnt_dev00001', '不等式应用', '{"dimension_id": "T_INEQUALITY_APPLY", "name": "不等式应用", "typical_ask": "用基本不等式求最值", "standard_steps": "配凑 ab 定值", "scoring_points": "取等可达性"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_TRIG_FUNC_RANGE', 'tnt_dev00001', '三角函数性质', '{"dimension_id": "T_TRIG_FUNC_RANGE", "name": "三角函数性质", "typical_ask": "求三角表达式范围", "standard_steps": "和差化积/辅助角", "scoring_points": "值域边界"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_TANGENT_IDENTITY', 'tnt_dev00001', '正切恒等式', '{"dimension_id": "T_TANGENT_IDENTITY", "name": "正切恒等式", "typical_ask": "三角形内角正切关系", "standard_steps": "tan 和角公式", "scoring_points": "恒等式适用条件"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_POWER_AND_CIRCLE', 'tnt_dev00001', '圆幂与隐圆', '{"dimension_id": "T_POWER_AND_CIRCLE", "name": "圆幂与隐圆", "typical_ask": "圆幂定理/隐圆轨迹", "standard_steps": "切割线/相交弦；定角轨迹", "scoring_points": "识别模型"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_PTOLEMY', 'tnt_dev00001', '托勒密定理', '{"dimension_id": "T_PTOLEMY", "name": "托勒密定理", "typical_ask": "圆内接四边形求对角线", "standard_steps": "托勒密定理", "scoring_points": "对边配对正确"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;

-- ── 错因 E（20 条） ──
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_SSA_MISSING_OBTUSE', 'tnt_dev00001', '遗漏 SSA 补角分支', '{"dimension_id": "E_SSA_MISSING_OBTUSE", "name": "遗漏 SSA 补角分支", "category": "分类讨论不完整", "manifestation": "只给锐角解，未讨论补角", "judgment_basis": "sinB 对应两角时仅取锐角", "remedial_advice": "补角判断卡：sinB=x 时 B 可能值"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_SINE_AMBIGUITY', 'tnt_dev00001', '正弦定理漏解或增解', '{"dimension_id": "E_SINE_AMBIGUITY", "name": "正弦定理漏解或增解", "category": "分类讨论不完整", "manifestation": "解数判断错误", "judgment_basis": "未验证 A+B<180° 或漏第二解", "remedial_advice": "逐解验证三角形存在性"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_COSINE_SIGN', 'tnt_dev00001', '余弦定理符号错误', '{"dimension_id": "E_COSINE_SIGN", "name": "余弦定理符号错误", "category": "公式误用", "manifestation": "中间项符号错（+2bc 等）", "judgment_basis": "代入展开检查", "remedial_advice": "重抄公式 a²=b²+c²−2bc·cosA"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_FORMULA_MISUSE', 'tnt_dev00001', '正余弦定理公式混用', '{"dimension_id": "E_FORMULA_MISUSE", "name": "正余弦定理公式混用", "category": "公式误用", "manifestation": "求边用余弦、求角用正弦混用", "judgment_basis": "条件与公式不匹配", "remedial_advice": "按已知条件选定理"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_AREA_HALF_MISS', 'tnt_dev00001', '面积公式漏 ½ 或 sinA', '{"dimension_id": "E_AREA_HALF_MISS", "name": "面积公式漏 ½ 或 sinA", "category": "公式误用", "manifestation": "面积计算差 ½ 倍", "judgment_basis": "结果与单位检查", "remedial_advice": "S=½·a·b·sinC 三步走"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_SHAPE_OVERGENERAL', 'tnt_dev00001', '形状判断过度泛化', '{"dimension_id": "E_SHAPE_OVERGENERAL", "name": "形状判断过度泛化", "category": "结论过度泛化", "manifestation": "仅凭一角定为某形状", "judgment_basis": "条件不足以推出结论", "remedial_advice": "逐一验证边/角关系"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_MEDIAN_FORMULA_ERR', 'tnt_dev00001', '中线长公式记错', '{"dimension_id": "E_MEDIAN_FORMULA_ERR", "name": "中线长公式记错", "category": "公式记忆错误", "manifestation": "系数或减号错误", "judgment_basis": "公式检验：等边三角形自检", "remedial_advice": "m_a=½√(2b²+2c²−a²) 特例验证"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_BISECTOR_RATIO_ERR', 'tnt_dev00001', '角平分线比例定理误用', '{"dimension_id": "E_BISECTOR_RATIO_ERR", "name": "角平分线比例定理误用", "category": "比例误用", "manifestation": "BD/DC 写成边反比", "judgment_basis": "比例方向错误", "remedial_advice": "BD/DC=AB/AC 对应写清"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_ALTITUDE_BASE_ERR', 'tnt_dev00001', '高线底边对应错误', '{"dimension_id": "E_ALTITUDE_BASE_ERR", "name": "高线底边对应错误", "category": "对应错误", "manifestation": "高与底边不匹配", "judgment_basis": "面积=½·底·高 对不上", "remedial_advice": "画图标注底与高"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_EQUAL_AREA_SETUP_ERR', 'tnt_dev00001', '等面积法列式错误', '{"dimension_id": "E_EQUAL_AREA_SETUP_ERR", "name": "等面积法列式错误", "category": "列式错误", "manifestation": "两种面积表达不等价", "judgment_basis": "表达式检查", "remedial_advice": "同一三角形面积写成两式"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_CIRCUMRADIUS_ERR', 'tnt_dev00001', '外接圆半径公式误用', '{"dimension_id": "E_CIRCUMRADIUS_ERR", "name": "外接圆半径公式误用", "category": "公式误用", "manifestation": "R=a/sinA 漏 2", "judgment_basis": "结果合理性检查", "remedial_advice": "R=a/(2sinA) 与正弦定理同源"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_INRADIUS_AREA_ERR', 'tnt_dev00001', '内切圆半径与面积关系误用', '{"dimension_id": "E_INRADIUS_AREA_ERR", "name": "内切圆半径与面积关系误用", "category": "公式误用", "manifestation": "r=S/s 用成 r=S/a", "judgment_basis": "数值验证", "remedial_advice": "r=S/s，s 为半周长"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_MULTI_TRI_ANGLE_ERR', 'tnt_dev00001', '多三角形公共角对应错误', '{"dimension_id": "E_MULTI_TRI_ANGLE_ERR", "name": "多三角形公共角对应错误", "category": "对应错误", "manifestation": "拆分后角度对应错", "judgment_basis": "几何图示核对", "remedial_advice": "拆分图画公共角标注"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_RANGE_END_MISS', 'tnt_dev00001', '最值取等条件遗漏', '{"dimension_id": "E_RANGE_END_MISS", "name": "最值取等条件遗漏", "category": "取等条件遗漏", "manifestation": "给出范围不含取等说明", "judgment_basis": "未验证取等可达", "remedial_advice": "取等条件：变量取值必须落在定义域"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_INEQUALITY_DIRECTION', 'tnt_dev00001', '基本不等式方向/取等误用', '{"dimension_id": "E_INEQUALITY_DIRECTION", "name": "基本不等式方向/取等误用", "category": "不等式误用", "manifestation": "用错 ≥/≤ 或取等不成立", "judgment_basis": "等号条件检验", "remedial_advice": "a+b 定值求 ab 最大，ab 定值求 a+b 最小"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_TRIG_RANGE_UNBOUNDED', 'tnt_dev00001', '三角函数值域误判', '{"dimension_id": "E_TRIG_RANGE_UNBOUNDED", "name": "三角函数值域误判", "category": "范围误判", "manifestation": "sin+sin 范围写成 [0,2]", "judgment_basis": "未用和差化积", "remedial_advice": "sinA+sinB=2sin((A+B)/2)cos((A−B)/2)"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_ANGLE_SIDE_CONVERT', 'tnt_dev00001', '角化边/边化角等价性破坏', '{"dimension_id": "E_ANGLE_SIDE_CONVERT", "name": "角化边/边化角等价性破坏", "category": "等价性破坏", "manifestation": "无中生有引入比例", "judgment_basis": "变换可逆性检查", "remedial_advice": "只允许正弦定理整式变换"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_TANGENT_DENOM_ZERO', 'tnt_dev00001', '正切恒等式分母为零', '{"dimension_id": "E_TANGENT_DENOM_ZERO", "name": "正切恒等式分母为零", "category": "定义域遗漏", "manifestation": "tan 和角分母为零时硬套", "judgment_basis": "分母检验", "remedial_advice": "A+B=90° 时 tan 无定义"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_HIDDEN_CIRCLE_MISS', 'tnt_dev00001', '隐圆几何关系未识别', '{"dimension_id": "E_HIDDEN_CIRCLE_MISS", "name": "隐圆几何关系未识别", "category": "模型识别失败", "manifestation": "定角条件未转轨迹", "judgment_basis": "角度恒定未用", "remedial_advice": "∠APB 定角→圆弧轨迹"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;
insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_COMPUTE_SLIP', 'tnt_dev00001', '运算粗心错误', '{"dimension_id": "E_COMPUTE_SLIP", "name": "运算粗心错误", "category": "运算粗心", "manifestation": "中间步骤符号/数值错误", "judgment_basis": "结果与估算偏差大", "remedial_advice": "代入验算、量纲检查"}')
on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;

-- ── 诊断规则 R（20 条，dimension_ids 关联 K/T，供题目关联诊断上下文，P0-7） ──
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_SSA_BRANCH_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_SSA_BRANCH_CHECK", "trigger": "sinB 值给出单一锐角解", "candidate_error_causes": ["E_SSA_MISSING_OBTUSE"], "probe": "sinB=x 时 B 的可能值有哪些？", "dimension_ids": ["K_SSA", "K_TRIANGLE_EXISTENCE", "T_SSA_BRANCH"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_SINE_AMBIGUITY_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_SINE_AMBIGUITY_CHECK", "trigger": "解数判断与存在性验证缺失", "candidate_error_causes": ["E_SINE_AMBIGUITY"], "probe": "两解都满足 A+B<180° 吗？逐个验证。", "dimension_ids": ["K_SSA", "K_TRIANGLE_EXISTENCE", "T_SSA_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_COSINE_SIGN_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_COSINE_SIGN_CHECK", "trigger": "余弦定理展开中间项符号错误", "candidate_error_causes": ["E_COSINE_SIGN"], "probe": "把余弦定理重新展开：a²=b²+c²−2bc·cosA。", "dimension_ids": ["K_COSINE_RULE", "T_SIDE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_FORMULA_MISUSE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_FORMULA_MISUSE_CHECK", "trigger": "已知条件与所用定理不匹配", "candidate_error_causes": ["E_FORMULA_MISUSE"], "probe": "这个条件应该用正弦还是余弦？为什么？", "dimension_ids": ["K_SINE_RULE", "K_COSINE_RULE", "T_ANGLE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_AREA_HALF_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_AREA_HALF_CHECK", "trigger": "面积结果与边长量级不符", "candidate_error_causes": ["E_AREA_HALF_MISS"], "probe": "面积公式写一遍，检查 ½ 与 sinA 是否都在。", "dimension_ids": ["K_TRIANGLE_AREA", "T_AREA_COMPUTE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_SHAPE_JUDGE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_SHAPE_JUDGE_CHECK", "trigger": "仅凭单一条件断言形状", "candidate_error_causes": ["E_SHAPE_OVERGENERAL"], "probe": "这个条件能推出什么？还需要什么条件？", "dimension_ids": ["K_SHAPE_JUDGE", "T_SHAPE_JUDGE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_MEDIAN_FORMULA_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_MEDIAN_FORMULA_CHECK", "trigger": "中线长公式系数/符号错误", "candidate_error_causes": ["E_MEDIAN_FORMULA_ERR"], "probe": "用等边三角形自检一遍中线公式。", "dimension_ids": ["K_MEDIAN", "T_MEDIAN_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_BISECTOR_RATIO_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_BISECTOR_RATIO_CHECK", "trigger": "角平分线分边比例方向错误", "candidate_error_causes": ["E_BISECTOR_RATIO_ERR"], "probe": "BD/DC 应等于哪两条边的比？", "dimension_ids": ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_ALTITUDE_BASE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_ALTITUDE_BASE_CHECK", "trigger": "高与底边不对应", "candidate_error_causes": ["E_ALTITUDE_BASE_ERR"], "probe": "这个高对应哪条底边？面积两种写法一致吗？", "dimension_ids": ["K_ALTITUDE", "T_ALTITUDE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_EQUAL_AREA_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_EQUAL_AREA_CHECK", "trigger": "等面积两种表达不相等", "candidate_error_causes": ["E_EQUAL_AREA_SETUP_ERR"], "probe": "同一面积写两种表达式再相等。", "dimension_ids": ["K_EQUAL_AREA", "T_EQUAL_AREA"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_CIRCUMRADIUS_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_CIRCUMRADIUS_CHECK", "trigger": "外接圆半径缺 2 倍", "candidate_error_causes": ["E_CIRCUMRADIUS_ERR"], "probe": "R 与 a、sinA 的关系式写全。", "dimension_ids": ["K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_INRADIUS_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_INRADIUS_CHECK", "trigger": "内切圆半径用错半周长", "candidate_error_causes": ["E_INRADIUS_AREA_ERR"], "probe": "r=S/s 里 s 是什么？", "dimension_ids": ["K_INCIRCLE", "T_INCIRCLE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_MULTI_TRIANGLE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_MULTI_TRIANGLE_CHECK", "trigger": "拆分三角形角度对应错误", "candidate_error_causes": ["E_MULTI_TRI_ANGLE_ERR"], "probe": "画出拆分图，标注公共角，重新对应。", "dimension_ids": ["K_MULTI_TRIANGLE", "T_MULTI_TRIANGLE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_RANGE_END_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_RANGE_END_CHECK", "trigger": "最值未验证取等条件", "candidate_error_causes": ["E_RANGE_END_MISS"], "probe": "取等条件成立吗？变量能取到吗？", "dimension_ids": ["K_INEQUALITY", "K_EDGE_RANGE", "T_MAX_MIN"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_INEQUALITY_DIR_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_INEQUALITY_DIR_CHECK", "trigger": "不等式方向或取等误用", "candidate_error_causes": ["E_INEQUALITY_DIRECTION"], "probe": "a+b 与 ab 哪个是定值？方向写对了吗？", "dimension_ids": ["K_INEQUALITY", "T_INEQUALITY_APPLY"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_TRIG_RANGE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_TRIG_RANGE_CHECK", "trigger": "三角式范围超出实际值域", "candidate_error_causes": ["E_TRIG_RANGE_UNBOUNDED"], "probe": "用和差化积把 sinA+sinB 化开再求范围。", "dimension_ids": ["K_TRIG_RANGE", "K_SIDE_TO_ANGLE", "T_TRIG_FUNC_RANGE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_ANGLE_SIDE_CONVERT_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_ANGLE_SIDE_CONVERT_CHECK", "trigger": "边角变换不可逆", "candidate_error_causes": ["E_ANGLE_SIDE_CONVERT"], "probe": "这个变换每一步都能逆回去吗？", "dimension_ids": ["K_ANGLE_TO_SIDE", "K_SIDE_TO_ANGLE", "T_ANGLE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_TANGENT_DENOM_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_TANGENT_DENOM_CHECK", "trigger": "正切和角分母为零", "candidate_error_causes": ["E_TANGENT_DENOM_ZERO"], "probe": "tan(A+B) 的分母在什么情况下为零？", "dimension_ids": ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_HIDDEN_CIRCLE_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_HIDDEN_CIRCLE_CHECK", "trigger": "定角条件未识别轨迹", "candidate_error_causes": ["E_HIDDEN_CIRCLE_MISS"], "probe": "角度恒定说明点 P 在什么曲线上？", "dimension_ids": ["K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;
insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_COMPUTE_SLIP_CHECK', 'tnt_dev00001', '1.0.0', '{"rule_id": "R_COMPUTE_SLIP_CHECK", "trigger": "结果与估算量级不符", "candidate_error_causes": ["E_COMPUTE_SLIP"], "probe": "把代入过程重新写一遍，逐行验算。", "dimension_ids": ["K_SINE_RULE", "K_COSINE_RULE", "T_SIDE_SOLVE"]}')
on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;

-- ── 题目 Q（82 道 = 80 新题 + 2 试点题，含评分点与测量目标；数值经人工验算） ──
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_TRI_012', 'tnt_dev00001', 'chap_tri_pilot', 1, 'open_solution', '{"K_SINE_RULE","K_SSA","K_TRIANGLE_EXISTENCE"}', '{"K_SSA","K_SINE_RULE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_TRI_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_tri_pilot", "question_version": 1, "stem_markdown": "在△ABC中，已知 a=√3，b=2，A=30°。求角 B（注意讨论解的个数）。", "stem_format": "open_solution", "answer": {"summary": "sinB = b·sinA/a = 1/√3，B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "正确列出正弦定理并解出 sinB", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "ssa_branch_check", "description": "检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件", "score_weight": 0.5, "evidence_rule": "ssa_branch_check"}]}, "tags": ["K_SINE_RULE", "K_SSA", "K_TRIANGLE_EXISTENCE"], "measurement_targets": [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"}, {"dim": "K_SINE_RULE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.existence_check"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_TRI_012', 'K_SSA', 'primary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_TRI_012', 'K_SINE_RULE', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_TRI_012', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.existence_check')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_TRI_020', 'tnt_dev00001', 'chap_tri_pilot', 1, 'open_solution', '{"K_SINE_RULE","K_SSA","K_TRIANGLE_EXISTENCE"}', '{"K_SSA","K_SINE_RULE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_TRI_020", "tenant_id": "tnt_dev00001", "chapter_id": "chap_tri_pilot", "question_version": 1, "stem_markdown": "在△ABC中，已知 a=2，b=2√2，A=30°。求角 B（注意讨论解的个数）。", "stem_format": "open_solution", "answer": {"summary": "sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "正确列出正弦定理并解出 sinB", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "ssa_branch_check", "description": "检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件", "score_weight": 0.5, "evidence_rule": "ssa_branch_check"}]}, "tags": ["K_SINE_RULE", "K_SSA", "K_TRIANGLE_EXISTENCE"], "measurement_targets": [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"}, {"dim": "K_SINE_RULE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.existence_check"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_TRI_020', 'K_SSA', 'primary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_TRI_020', 'K_SINE_RULE', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_TRI_020', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.existence_check')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_001', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SINE_RULE","K_TRIANGLE_EXISTENCE","T_SSA_SOLVE"}', '{"K_SINE_RULE","T_SSA_SOLVE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_BAS_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，已知 a=2，b=2√2，A=45°。求角 B，并说明解的个数。", "stem_format": "open_solution", "answer": {"summary": "sinB = b·sinA/a = 2√2·(√2/2)/2 = 1 → B=90°，唯一解。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "正确列出正弦定理并解出 sinB", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "ssa_branch_check", "description": "讨论解的个数并验证存在性", "score_weight": 0.5, "evidence_rule": "ssa_branch_check"}]}, "tags": ["K_SINE_RULE", "K_TRIANGLE_EXISTENCE", "T_SSA_SOLVE"], "measurement_targets": [{"dim": "K_SINE_RULE", "role": "primary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "T_SSA_SOLVE", "role": "secondary", "evidence_rule": "rubric.ssa_branch_check"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_001', 'K_SINE_RULE', 'primary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_BAS_001', 'T_SSA_SOLVE', 'secondary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_BAS_001', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_001', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_001', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_001', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_002', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SSA","K_SINE_RULE","K_TRIANGLE_EXISTENCE","T_SSA_BRANCH"}', '{"K_SSA","T_SSA_BRANCH","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_BAS_002", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，已知 a=4，b=4√2，A=30°。求角 B（注意讨论解的个数）。", "stem_format": "open_solution", "answer": {"summary": "sinB = b·sinA/a = 4√2·(1/2)/4 = √2/2 → B=45° 或 135°，两解均满足 A+B<180°。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "正确列出正弦定理并解出 sinB", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "ssa_branch_check", "description": "检验补角分支并验证两解均合法", "score_weight": 0.5, "evidence_rule": "ssa_branch_check"}]}, "tags": ["K_SSA", "K_SINE_RULE", "K_TRIANGLE_EXISTENCE", "T_SSA_BRANCH"], "measurement_targets": [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"}, {"dim": "T_SSA_BRANCH", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_002', 'K_SSA', 'primary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_BAS_002', 'T_SSA_BRANCH', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_BAS_002', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_002', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_002', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_002', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_003', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SINE_RULE","T_ANGLE_SOLVE"}', '{"K_SINE_RULE","T_ANGLE_SOLVE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_BAS_003", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，A=60°，B=45°，b=2√2。求边 a。", "stem_format": "open_solution", "answer": {"summary": "a = b·sinA/sinB = 2√2·(√3/2)/(√2/2) = 2√3。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "写出正弦定理比例式", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "solve_side", "description": "代入角度正弦并化简", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_SINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_SINE_RULE", "role": "primary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_003', 'K_SINE_RULE', 'primary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_BAS_003', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_BAS_003', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_003', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_003', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_003', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_004', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","T_SIDE_SOLVE"}', '{"K_COSINE_RULE","T_SIDE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_BAS_004", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，b=3，c=4，A=60°。求边 a。", "stem_format": "open_solution", "answer": {"summary": "a² = b²+c²−2bc·cosA = 9+16−24·(1/2) = 13 → a=√13。"}, "rubric": {"items": [{"id": "apply_cosine", "description": "正确代入余弦定理", "score_weight": 0.5, "evidence_rule": "apply_cosine"}, {"id": "extract_root", "description": "开方取正值并验算", "score_weight": 0.5, "evidence_rule": "extract_root"}]}, "tags": ["K_COSINE_RULE", "T_SIDE_SOLVE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.apply_cosine"}, {"dim": "T_SIDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.extract_root"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_004', 'K_COSINE_RULE', 'primary', 'rubric.apply_cosine'),
  ('tnt_dev00001', 'Q_BAS_004', 'T_SIDE_SOLVE', 'secondary', 'rubric.extract_root'),
  ('tnt_dev00001', 'Q_BAS_004', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_004', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_004', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_004', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_005', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","T_ANGLE_SOLVE"}', '{"K_COSINE_RULE","T_ANGLE_SOLVE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_BAS_005", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，a=√7，b=2，c=√3。求角 A。", "stem_format": "open_solution", "answer": {"summary": "cosA = (b²+c²−a²)/(2bc) = (4+3−7)/(4√3) = 0 → A=90°。"}, "rubric": {"items": [{"id": "apply_cosine", "description": "写出 cosA 表达式", "score_weight": 0.5, "evidence_rule": "apply_cosine"}, {"id": "solve_angle", "description": "化简并求出角 A", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_COSINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.apply_cosine"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_005', 'K_COSINE_RULE', 'primary', 'rubric.apply_cosine'),
  ('tnt_dev00001', 'Q_BAS_005', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_BAS_005', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_005', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_005', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_005', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_006', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_TRIANGLE_AREA","T_AREA_COMPUTE"}', '{"K_TRIANGLE_AREA","T_AREA_COMPUTE","K_COSINE_RULE"}', true, '{"question_id": "Q_BAS_006", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，b=5，c=6，A=30°。求面积 S。", "stem_format": "open_solution", "answer": {"summary": "S = ½·b·c·sinA = ½·5·6·(1/2) = 15/2。"}, "rubric": {"items": [{"id": "area_formula", "description": "写出 S=½bc·sinA", "score_weight": 0.5, "evidence_rule": "area_formula"}, {"id": "area_compute", "description": "代入数值计算", "score_weight": 0.5, "evidence_rule": "area_compute"}]}, "tags": ["K_TRIANGLE_AREA", "T_AREA_COMPUTE"], "measurement_targets": [{"dim": "K_TRIANGLE_AREA", "role": "primary", "evidence_rule": "rubric.area_formula"}, {"dim": "T_AREA_COMPUTE", "role": "secondary", "evidence_rule": "rubric.area_compute"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_006', 'K_TRIANGLE_AREA', 'primary', 'rubric.area_formula'),
  ('tnt_dev00001', 'Q_BAS_006', 'T_AREA_COMPUTE', 'secondary', 'rubric.area_compute'),
  ('tnt_dev00001', 'Q_BAS_006', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_006', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_006', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_006', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_007', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_TRIANGLE_AREA","K_SINE_RULE","T_AREA_COMPUTE"}', '{"K_TRIANGLE_AREA","T_AREA_COMPUTE","K_SINE_RULE"}', true, '{"question_id": "Q_BAS_007", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，面积 S=3√3，b=2，c=6。求角 A。", "stem_format": "open_solution", "answer": {"summary": "½·2·6·sinA = 3√3 → sinA = √3/2 → A=60° 或 120°（均使 A+B+C=180° 成立）。"}, "rubric": {"items": [{"id": "area_formula", "description": "由面积公式列方程", "score_weight": 0.5, "evidence_rule": "area_formula"}, {"id": "solve_angle", "description": "解出 A 并讨论两解", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_TRIANGLE_AREA", "K_SINE_RULE", "T_AREA_COMPUTE"], "measurement_targets": [{"dim": "K_TRIANGLE_AREA", "role": "primary", "evidence_rule": "rubric.area_formula"}, {"dim": "T_AREA_COMPUTE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_007', 'K_TRIANGLE_AREA', 'primary', 'rubric.area_formula'),
  ('tnt_dev00001', 'Q_BAS_007', 'T_AREA_COMPUTE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_BAS_007', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_007', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_007', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_007', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_008', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SHAPE_JUDGE","K_COSINE_RULE","T_SHAPE_JUDGE"}', '{"K_SHAPE_JUDGE","T_SHAPE_JUDGE","K_COSINE_RULE"}', true, '{"question_id": "Q_BAS_008", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，若 a=2b·cosC，判断三角形形状。", "stem_format": "open_solution", "answer": {"summary": "a = 2b·(a²+b²−c²)/(2ab) → a² = a²+b²−c² → b²=c² → b=c，等腰三角形。"}, "rubric": {"items": [{"id": "convert_formula", "description": "把 cosC 用余弦定理展开", "score_weight": 0.5, "evidence_rule": "convert_formula"}, {"id": "conclude_shape", "description": "化简并下结论", "score_weight": 0.5, "evidence_rule": "conclude_shape"}]}, "tags": ["K_SHAPE_JUDGE", "K_COSINE_RULE", "T_SHAPE_JUDGE"], "measurement_targets": [{"dim": "K_SHAPE_JUDGE", "role": "primary", "evidence_rule": "rubric.convert_formula"}, {"dim": "T_SHAPE_JUDGE", "role": "secondary", "evidence_rule": "rubric.conclude_shape"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_008', 'K_SHAPE_JUDGE', 'primary', 'rubric.convert_formula'),
  ('tnt_dev00001', 'Q_BAS_008', 'T_SHAPE_JUDGE', 'secondary', 'rubric.conclude_shape'),
  ('tnt_dev00001', 'Q_BAS_008', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_008', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_008', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_008', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_009', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SHAPE_JUDGE","K_SINE_RULE","T_SHAPE_JUDGE"}', '{"K_SHAPE_JUDGE","T_SHAPE_JUDGE","K_SINE_RULE"}', true, '{"question_id": "Q_BAS_009", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，若 (a+b+c)(b+c−a)=3bc，求角 A，并判断该三角形是否一定为等边三角形。", "stem_format": "open_solution", "answer": {"summary": "(b+c)²−a²=3bc → a²=b²+c²−bc，故 cosA=(b²+c²−a²)/(2bc)=1/2 → A=60°。条件只确定 A；例如 b=2、c=3 时 a=√7，三边不等但仍满足条件，因此不一定是等边三角形。"}, "rubric": {"items": [{"id": "expand_product", "description": "展开并化简边关系", "score_weight": 0.5, "evidence_rule": "expand_product"}, {"id": "conclude_shape", "description": "由余弦定理得 A=60°，并用反例说明不一定等边", "score_weight": 0.5, "evidence_rule": "conclude_shape"}]}, "tags": ["K_SHAPE_JUDGE", "K_SINE_RULE", "T_SHAPE_JUDGE"], "measurement_targets": [{"dim": "K_SHAPE_JUDGE", "role": "primary", "evidence_rule": "rubric.expand_product"}, {"dim": "T_SHAPE_JUDGE", "role": "secondary", "evidence_rule": "rubric.conclude_shape"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_009', 'K_SHAPE_JUDGE', 'primary', 'rubric.expand_product'),
  ('tnt_dev00001', 'Q_BAS_009', 'T_SHAPE_JUDGE', 'secondary', 'rubric.conclude_shape'),
  ('tnt_dev00001', 'Q_BAS_009', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_009', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_009', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_009', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_010', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_TRIANGLE_EXISTENCE","K_SINE_RULE","T_SSA_SOLVE"}', '{"K_TRIANGLE_EXISTENCE","T_SSA_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_BAS_010", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，已知 a=√3，b=2，A=60°。求角 B 并判断解的个数。", "stem_format": "open_solution", "answer": {"summary": "sinB = 2·(√3/2)/√3 = 1 → B=90°，唯一解。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "列出正弦定理", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "count_solutions", "description": "判断解数并说明理由", "score_weight": 0.5, "evidence_rule": "count_solutions"}]}, "tags": ["K_TRIANGLE_EXISTENCE", "K_SINE_RULE", "T_SSA_SOLVE"], "measurement_targets": [{"dim": "K_TRIANGLE_EXISTENCE", "role": "primary", "evidence_rule": "rubric.count_solutions"}, {"dim": "T_SSA_SOLVE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_010', 'K_TRIANGLE_EXISTENCE', 'primary', 'rubric.count_solutions'),
  ('tnt_dev00001', 'Q_BAS_010', 'T_SSA_SOLVE', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_BAS_010', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_010', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_010', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_010', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_011', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","T_SIDE_SOLVE"}', '{"K_COSINE_RULE","T_SIDE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_BAS_011", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，A=30°，b=2√3，c=3。求边 a。", "stem_format": "open_solution", "answer": {"summary": "a² = 12+9−2·2√3·3·(√3/2) = 21−18 = 3 → a=√3。"}, "rubric": {"items": [{"id": "apply_cosine", "description": "代入余弦定理", "score_weight": 0.5, "evidence_rule": "apply_cosine"}, {"id": "extract_root", "description": "化简开方", "score_weight": 0.5, "evidence_rule": "extract_root"}]}, "tags": ["K_COSINE_RULE", "T_SIDE_SOLVE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.apply_cosine"}, {"dim": "T_SIDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.extract_root"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_011', 'K_COSINE_RULE', 'primary', 'rubric.apply_cosine'),
  ('tnt_dev00001', 'Q_BAS_011', 'T_SIDE_SOLVE', 'secondary', 'rubric.extract_root'),
  ('tnt_dev00001', 'Q_BAS_011', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_011', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_011', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_011', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_012', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","K_TRIANGLE_AREA","T_SIDE_SOLVE"}', '{"K_COSINE_RULE","T_SIDE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_BAS_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，a=√3，c=1，B=30°。求边 b 与面积 S。", "stem_format": "open_solution", "answer": {"summary": "b² = 3+1−2·√3·1·(√3/2) = 1 → b=1；S=½·√3·1·(1/2)=√3/4。"}, "rubric": {"items": [{"id": "apply_cosine", "description": "余弦定理求 b", "score_weight": 0.5, "evidence_rule": "apply_cosine"}, {"id": "compute_area", "description": "面积公式求 S", "score_weight": 0.5, "evidence_rule": "compute_area"}]}, "tags": ["K_COSINE_RULE", "K_TRIANGLE_AREA", "T_SIDE_SOLVE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.apply_cosine"}, {"dim": "T_SIDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_area"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_012', 'K_COSINE_RULE', 'primary', 'rubric.apply_cosine'),
  ('tnt_dev00001', 'Q_BAS_012', 'T_SIDE_SOLVE', 'secondary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_BAS_012', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_013', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","T_ANGLE_SOLVE"}', '{"K_COSINE_RULE","T_ANGLE_SOLVE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_BAS_013", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，a:b:c = 3:5:7。求最大角。", "stem_format": "open_solution", "answer": {"summary": "cosC = (9+25−49)/(2·3·5) = −15/30 = −1/2 → C=120°。"}, "rubric": {"items": [{"id": "apply_cosine", "description": "对最大边对应角用余弦定理", "score_weight": 0.5, "evidence_rule": "apply_cosine"}, {"id": "solve_angle", "description": "求出最大角", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_COSINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.apply_cosine"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_013', 'K_COSINE_RULE', 'primary', 'rubric.apply_cosine'),
  ('tnt_dev00001', 'Q_BAS_013', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_BAS_013', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_013', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_013', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_013', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_014', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_COSINE_RULE","K_TRIANGLE_AREA","T_AREA_COMPUTE"}', '{"K_COSINE_RULE","T_AREA_COMPUTE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_BAS_014", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，A=60°，面积 S=4√3，周长 12。求三边。", "stem_format": "open_solution", "answer": {"summary": "½bc·(√3/2)=4√3 → bc=16；a²=b²+c²−bc=(b+c)²−3bc=(12−a)²−48 → a=4，b+c=8 且 bc=16 → b=c=4。三边均为 4（等边）。"}, "rubric": {"items": [{"id": "area_equation", "description": "由面积列 bc 关系", "score_weight": 0.5, "evidence_rule": "area_equation"}, {"id": "solve_sides", "description": "联立周长与余弦定理解边", "score_weight": 0.5, "evidence_rule": "solve_sides"}]}, "tags": ["K_COSINE_RULE", "K_TRIANGLE_AREA", "T_AREA_COMPUTE"], "measurement_targets": [{"dim": "K_COSINE_RULE", "role": "primary", "evidence_rule": "rubric.area_equation"}, {"dim": "T_AREA_COMPUTE", "role": "secondary", "evidence_rule": "rubric.solve_sides"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_014', 'K_COSINE_RULE', 'primary', 'rubric.area_equation'),
  ('tnt_dev00001', 'Q_BAS_014', 'T_AREA_COMPUTE', 'secondary', 'rubric.solve_sides'),
  ('tnt_dev00001', 'Q_BAS_014', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_014', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_014', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_014', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_015', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_SINE_RULE","T_ANGLE_SOLVE"}', '{"K_SINE_RULE","T_ANGLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_BAS_015", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，B=75°，C=45°，a=4。求边 b。", "stem_format": "open_solution", "answer": {"summary": "A=60°；b = a·sinB/sinA = 4·sin75°/sin60° = 4·((√6+√2)/4)/(√3/2) = 4√2。"}, "rubric": {"items": [{"id": "setup_sine_rule", "description": "求 A 并列出正弦定理", "score_weight": 0.5, "evidence_rule": "setup_sine_rule"}, {"id": "solve_side", "description": "代入化简求 b", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_SINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_SINE_RULE", "role": "primary", "evidence_rule": "rubric.setup_sine_rule"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_015', 'K_SINE_RULE', 'primary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_BAS_015', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_BAS_015', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_015', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_015', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_015', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_BAS_016', 'tnt_dev00001', 'chap_01', 1, 'open_solution', '{"K_TRIANGLE_AREA","K_COSINE_RULE","T_AREA_COMPUTE"}', '{"K_TRIANGLE_AREA","T_AREA_COMPUTE","K_COSINE_RULE"}', true, '{"question_id": "Q_BAS_016", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "question_version": 1, "stem_markdown": "在△ABC中，a=5，b=6，c=7。求面积 S。", "stem_format": "open_solution", "answer": {"summary": "s=9，S=√(9·4·3·2)=√216=6√6。"}, "rubric": {"items": [{"id": "area_formula", "description": "用海伦公式或余弦定理求面积", "score_weight": 0.5, "evidence_rule": "area_formula"}, {"id": "area_compute", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "area_compute"}]}, "tags": ["K_TRIANGLE_AREA", "K_COSINE_RULE", "T_AREA_COMPUTE"], "measurement_targets": [{"dim": "K_TRIANGLE_AREA", "role": "primary", "evidence_rule": "rubric.area_formula"}, {"dim": "T_AREA_COMPUTE", "role": "secondary", "evidence_rule": "rubric.area_compute"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_BAS_016', 'K_TRIANGLE_AREA', 'primary', 'rubric.area_formula'),
  ('tnt_dev00001', 'Q_BAS_016', 'T_AREA_COMPUTE', 'secondary', 'rubric.area_compute'),
  ('tnt_dev00001', 'Q_BAS_016', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_BAS_016', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_016', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_BAS_016', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_001', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","K_COSINE_RULE","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，a=2，b=3，c=4。求 BC 边上的中线长 m_a。", "stem_format": "open_solution", "answer": {"summary": "m_a = ½√(2b²+2c²−a²) = ½√(18+32−4) = ½√46。"}, "rubric": {"items": [{"id": "median_formula", "description": "写出中线长公式", "score_weight": 0.5, "evidence_rule": "median_formula"}, {"id": "compute_median", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_median"}]}, "tags": ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.median_formula"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_median"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_001', 'K_MEDIAN', 'primary', 'rubric.median_formula'),
  ('tnt_dev00001', 'Q_SEG_001', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.compute_median'),
  ('tnt_dev00001', 'Q_SEG_001', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_001', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_001', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_001', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_002', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","K_COSINE_RULE","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_002", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，AB=4，AC=6，A=60°。求 BC 边上的中线长。", "stem_format": "open_solution", "answer": {"summary": "BC²=16+36−48·(1/2)=28；m_a²=(2·36+2·16−28)/4=19 → m_a=√19。"}, "rubric": {"items": [{"id": "median_formula", "description": "先求 BC 再代中线公式", "score_weight": 0.5, "evidence_rule": "median_formula"}, {"id": "compute_median", "description": "计算并开方", "score_weight": 0.5, "evidence_rule": "compute_median"}]}, "tags": ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.median_formula"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_median"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_002', 'K_MEDIAN', 'primary', 'rubric.median_formula'),
  ('tnt_dev00001', 'Q_SEG_002', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.compute_median'),
  ('tnt_dev00001', 'Q_SEG_002', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_002', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_002', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_002', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_003', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","K_EQUAL_AREA","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_EQUAL_AREA"}', true, '{"question_id": "Q_SEG_003", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，三条中线交于重心 G。若 AG=8，求中线 AD 的长。", "stem_format": "open_solution", "answer": {"summary": "重心分中线 AG:GD=2:1 → AD = AG·3/2 = 12。"}, "rubric": {"items": [{"id": "centroid_ratio", "description": "写出重心分中线比例", "score_weight": 0.5, "evidence_rule": "centroid_ratio"}, {"id": "compute_length", "description": "由比例求全长", "score_weight": 0.5, "evidence_rule": "compute_length"}]}, "tags": ["K_MEDIAN", "K_EQUAL_AREA", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.centroid_ratio"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_length"}, {"dim": "K_EQUAL_AREA", "role": "prerequisite", "evidence_rule": "probe.K_EQUAL_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_003', 'K_MEDIAN', 'primary', 'rubric.centroid_ratio'),
  ('tnt_dev00001', 'Q_SEG_003', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.compute_length'),
  ('tnt_dev00001', 'Q_SEG_003', 'K_EQUAL_AREA', 'prerequisite', 'probe.K_EQUAL_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_003', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_003', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_003', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_004', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE"}', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_SEG_004", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，AD 平分∠A 交 BC 于 D。AB=3，AC=6，BD=2。求 DC。", "stem_format": "open_solution", "answer": {"summary": "BD/DC = AB/AC = 3/6 = 1/2 → DC = 4。"}, "rubric": {"items": [{"id": "bisector_ratio", "description": "写出角平分线比例定理", "score_weight": 0.5, "evidence_rule": "bisector_ratio"}, {"id": "solve_dc", "description": "代入比例求 DC", "score_weight": 0.5, "evidence_rule": "solve_dc"}]}, "tags": ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"], "measurement_targets": [{"dim": "K_ANGLE_BISECTOR", "role": "primary", "evidence_rule": "rubric.bisector_ratio"}, {"dim": "T_BISECTOR_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_dc"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_004', 'K_ANGLE_BISECTOR', 'primary', 'rubric.bisector_ratio'),
  ('tnt_dev00001', 'Q_SEG_004', 'T_BISECTOR_SOLVE', 'secondary', 'rubric.solve_dc'),
  ('tnt_dev00001', 'Q_SEG_004', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_004', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_004', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_004', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_005', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ANGLE_BISECTOR","K_COSINE_RULE","T_BISECTOR_SOLVE"}', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_005", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，A=60°，AB=6，AC=8。AD 平分∠A 交 BC 于 D。求 AD。", "stem_format": "open_solution", "answer": {"summary": "AD = 2bc·cos(A/2)/(b+c) = 2·6·8·(√3/2)/14 = 24√3/7。"}, "rubric": {"items": [{"id": "bisector_length", "description": "写出角平分线长公式", "score_weight": 0.5, "evidence_rule": "bisector_length"}, {"id": "compute_length", "description": "代入并化简", "score_weight": 0.5, "evidence_rule": "compute_length"}]}, "tags": ["K_ANGLE_BISECTOR", "K_COSINE_RULE", "T_BISECTOR_SOLVE"], "measurement_targets": [{"dim": "K_ANGLE_BISECTOR", "role": "primary", "evidence_rule": "rubric.bisector_length"}, {"dim": "T_BISECTOR_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_length"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_005', 'K_ANGLE_BISECTOR', 'primary', 'rubric.bisector_length'),
  ('tnt_dev00001', 'Q_SEG_005', 'T_BISECTOR_SOLVE', 'secondary', 'rubric.compute_length'),
  ('tnt_dev00001', 'Q_SEG_005', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_005', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_005', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_005', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_006', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ANGLE_BISECTOR","K_TRIANGLE_AREA","T_BISECTOR_SOLVE"}', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_006", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，A=120°，AB=4，AC=6，AD 平分∠A 交 BC 于 D。求 S_△ABD。", "stem_format": "open_solution", "answer": {"summary": "S=½·4·6·sin120°=6√3；BD/DC=4/6=2/3 → S_△ABD = 6√3·2/5 = 12√3/5。"}, "rubric": {"items": [{"id": "area_split", "description": "总面积与分边比例", "score_weight": 0.5, "evidence_rule": "area_split"}, {"id": "compute_part", "description": "按比例求部分面积", "score_weight": 0.5, "evidence_rule": "compute_part"}]}, "tags": ["K_ANGLE_BISECTOR", "K_TRIANGLE_AREA", "T_BISECTOR_SOLVE"], "measurement_targets": [{"dim": "K_ANGLE_BISECTOR", "role": "primary", "evidence_rule": "rubric.area_split"}, {"dim": "T_BISECTOR_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_part"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_006', 'K_ANGLE_BISECTOR', 'primary', 'rubric.area_split'),
  ('tnt_dev00001', 'Q_SEG_006', 'T_BISECTOR_SOLVE', 'secondary', 'rubric.compute_part'),
  ('tnt_dev00001', 'Q_SEG_006', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_006', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_006', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_006', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_007', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ALTITUDE","K_TRIANGLE_AREA","T_ALTITUDE_SOLVE"}', '{"K_ALTITUDE","T_ALTITUDE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_007", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，AB=5，AC=7，BC=8。求 BC 边上的高 h_a。", "stem_format": "open_solution", "answer": {"summary": "cosA=(49+64−25)/(2·7·8)=11/14 → sinA=5√3/14 → S=½·7·5·5√3/14=25√3/4 → h_a=2S/8=25√3/16。"}, "rubric": {"items": [{"id": "compute_area", "description": "由两边夹一角求面积", "score_weight": 0.5, "evidence_rule": "compute_area"}, {"id": "altitude_from_area", "description": "h=2S/a 求高", "score_weight": 0.5, "evidence_rule": "altitude_from_area"}]}, "tags": ["K_ALTITUDE", "K_TRIANGLE_AREA", "T_ALTITUDE_SOLVE"], "measurement_targets": [{"dim": "K_ALTITUDE", "role": "primary", "evidence_rule": "rubric.altitude_from_area"}, {"dim": "T_ALTITUDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_area"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_007', 'K_ALTITUDE', 'primary', 'rubric.altitude_from_area'),
  ('tnt_dev00001', 'Q_SEG_007', 'T_ALTITUDE_SOLVE', 'secondary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_SEG_007', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_007', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_007', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_007', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_008', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ALTITUDE","T_ALTITUDE_SOLVE"}', '{"K_ALTITUDE","T_ALTITUDE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_008", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，BC=10，B=45°，C=30°。AD 为 BC 边上的高。求 AD。", "stem_format": "open_solution", "answer": {"summary": "设 h=AD，h/tanB 与 h/tanC 分别为 BD、DC → h(1+√3)=10 → h=10/(1+√3)=5(√3−1)。"}, "rubric": {"items": [{"id": "split_base", "description": "把底边按高拆成两段", "score_weight": 0.5, "evidence_rule": "split_base"}, {"id": "solve_height", "description": "解方程求高", "score_weight": 0.5, "evidence_rule": "solve_height"}]}, "tags": ["K_ALTITUDE", "T_ALTITUDE_SOLVE"], "measurement_targets": [{"dim": "K_ALTITUDE", "role": "primary", "evidence_rule": "rubric.split_base"}, {"dim": "T_ALTITUDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_height"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_008', 'K_ALTITUDE', 'primary', 'rubric.split_base'),
  ('tnt_dev00001', 'Q_SEG_008', 'T_ALTITUDE_SOLVE', 'secondary', 'rubric.solve_height'),
  ('tnt_dev00001', 'Q_SEG_008', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_008', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_008', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_008', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_009', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ZHANG_ANGLE","K_ALTITUDE","T_ALTITUDE_SOLVE"}', '{"K_ZHANG_ANGLE","T_ALTITUDE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_SEG_009", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，A=90°，AD⊥BC 于 D，BD=2，DC=6。求高 AD。", "stem_format": "open_solution", "answer": {"summary": "tanB=h/2，tanC=h/6，B+C=90° → tanB·tanC=1 → h²/12=1 → h=2√3。"}, "rubric": {"items": [{"id": "tangent_setup", "description": "用两角正切列式", "score_weight": 0.5, "evidence_rule": "tangent_setup"}, {"id": "solve_height", "description": "利用互余关系求 h", "score_weight": 0.5, "evidence_rule": "solve_height"}]}, "tags": ["K_ZHANG_ANGLE", "K_ALTITUDE", "T_ALTITUDE_SOLVE"], "measurement_targets": [{"dim": "K_ZHANG_ANGLE", "role": "primary", "evidence_rule": "rubric.tangent_setup"}, {"dim": "T_ALTITUDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_height"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_009', 'K_ZHANG_ANGLE', 'primary', 'rubric.tangent_setup'),
  ('tnt_dev00001', 'Q_SEG_009', 'T_ALTITUDE_SOLVE', 'secondary', 'rubric.solve_height'),
  ('tnt_dev00001', 'Q_SEG_009', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_009', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_009', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_009', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_010', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_EQUAL_AREA","K_TRIANGLE_AREA","T_EQUAL_AREA"}', '{"K_EQUAL_AREA","T_EQUAL_AREA","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_010", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，三边为 13，14，15。求最短边上的高。", "stem_format": "open_solution", "answer": {"summary": "s=21，S=√(21·8·7·6)=84 → 最短边 13 → h=2S/13=168/13。"}, "rubric": {"items": [{"id": "compute_area", "description": "海伦公式求面积", "score_weight": 0.5, "evidence_rule": "compute_area"}, {"id": "shortest_height", "description": "面积除以最短底边", "score_weight": 0.5, "evidence_rule": "shortest_height"}]}, "tags": ["K_EQUAL_AREA", "K_TRIANGLE_AREA", "T_EQUAL_AREA"], "measurement_targets": [{"dim": "K_EQUAL_AREA", "role": "primary", "evidence_rule": "rubric.compute_area"}, {"dim": "T_EQUAL_AREA", "role": "secondary", "evidence_rule": "rubric.shortest_height"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_010', 'K_EQUAL_AREA', 'primary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_SEG_010', 'T_EQUAL_AREA', 'secondary', 'rubric.shortest_height'),
  ('tnt_dev00001', 'Q_SEG_010', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_010', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_010', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_010', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_011', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_EQUAL_AREA","K_TRIANGLE_AREA","T_EQUAL_AREA"}', '{"K_EQUAL_AREA","T_EQUAL_AREA","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_011", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "边长为 4 的等边三角形，用等面积法求高。", "stem_format": "open_solution", "answer": {"summary": "S=½·4·4·sin60°=4√3 → h=2S/4=2√3。"}, "rubric": {"items": [{"id": "compute_area", "description": "面积两种写法", "score_weight": 0.5, "evidence_rule": "compute_area"}, {"id": "solve_height", "description": "由 h=2S/a 求高", "score_weight": 0.5, "evidence_rule": "solve_height"}]}, "tags": ["K_EQUAL_AREA", "K_TRIANGLE_AREA", "T_EQUAL_AREA"], "measurement_targets": [{"dim": "K_EQUAL_AREA", "role": "primary", "evidence_rule": "rubric.compute_area"}, {"dim": "T_EQUAL_AREA", "role": "secondary", "evidence_rule": "rubric.solve_height"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_011', 'K_EQUAL_AREA', 'primary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_SEG_011', 'T_EQUAL_AREA', 'secondary', 'rubric.solve_height'),
  ('tnt_dev00001', 'Q_SEG_011', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_011', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_011', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_011', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_012', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，b=6，c=4，BC 边上的中线 m_a=5。求 a。", "stem_format": "open_solution", "answer": {"summary": "25=(2·36+2·16−a²)/4 → 100=104−a² → a²=4 → a=2。"}, "rubric": {"items": [{"id": "median_formula", "description": "代入中线长公式", "score_weight": 0.5, "evidence_rule": "median_formula"}, {"id": "solve_side", "description": "解方程求 a", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_MEDIAN", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.median_formula"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_012', 'K_MEDIAN', 'primary', 'rubric.median_formula'),
  ('tnt_dev00001', 'Q_SEG_012', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_SEG_012', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_013', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE"}', '{"K_ANGLE_BISECTOR","T_BISECTOR_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_SEG_013", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，D 在 BC 上，AB=4，AC=6，BD=2，DC=3。判断 AD 是否为角平分线。", "stem_format": "open_solution", "answer": {"summary": "BD/DC=2/3，AB/AC=4/6=2/3，比值相等 → AD 是∠A 的平分线。"}, "rubric": {"items": [{"id": "bisector_ratio", "description": "计算两边比与分边比", "score_weight": 0.5, "evidence_rule": "bisector_ratio"}, {"id": "conclude", "description": "由比例判定", "score_weight": 0.5, "evidence_rule": "conclude"}]}, "tags": ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"], "measurement_targets": [{"dim": "K_ANGLE_BISECTOR", "role": "primary", "evidence_rule": "rubric.bisector_ratio"}, {"dim": "T_BISECTOR_SOLVE", "role": "secondary", "evidence_rule": "rubric.conclude"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_013', 'K_ANGLE_BISECTOR', 'primary', 'rubric.bisector_ratio'),
  ('tnt_dev00001', 'Q_SEG_013', 'T_BISECTOR_SOLVE', 'secondary', 'rubric.conclude'),
  ('tnt_dev00001', 'Q_SEG_013', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_013', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_013', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_013', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_014', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_ALTITUDE","K_TRIANGLE_AREA","T_ALTITUDE_SOLVE"}', '{"K_ALTITUDE","T_ALTITUDE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_SEG_014", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，A=45°，b=4√2，面积 S=8。求边 c。", "stem_format": "open_solution", "answer": {"summary": "½·4√2·c·(√2/2)=8 → 2c=8 → c=4。"}, "rubric": {"items": [{"id": "area_equation", "description": "由面积公式列方程", "score_weight": 0.5, "evidence_rule": "area_equation"}, {"id": "solve_side", "description": "解出 c", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_ALTITUDE", "K_TRIANGLE_AREA", "T_ALTITUDE_SOLVE"], "measurement_targets": [{"dim": "K_ALTITUDE", "role": "primary", "evidence_rule": "rubric.area_equation"}, {"dim": "T_ALTITUDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_014', 'K_ALTITUDE', 'primary', 'rubric.area_equation'),
  ('tnt_dev00001', 'Q_SEG_014', 'T_ALTITUDE_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_SEG_014', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_014', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_014', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_014', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_015', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","K_COSINE_RULE","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_015", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，b=4，c=6，BC 边上的中线 m_a=√13。求 a。", "stem_format": "open_solution", "answer": {"summary": "13=(2·16+2·36−a²)/4 → 52=104−a² → a²=52 → a=2√13。"}, "rubric": {"items": [{"id": "median_formula", "description": "代入中线长公式", "score_weight": 0.5, "evidence_rule": "median_formula"}, {"id": "solve_side", "description": "解方程求 a", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.median_formula"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_015', 'K_MEDIAN', 'primary', 'rubric.median_formula'),
  ('tnt_dev00001', 'Q_SEG_015', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_SEG_015', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_015', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_015', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_015', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_SEG_016', 'tnt_dev00001', 'chap_02', 1, 'open_solution', '{"K_MEDIAN","K_COSINE_RULE","T_MEDIAN_SOLVE"}', '{"K_MEDIAN","T_MEDIAN_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_SEG_016", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "question_version": 1, "stem_markdown": "在△ABC中，b=8，c=5，BC 边上的中线 m_a=√21。求 a。", "stem_format": "open_solution", "answer": {"summary": "21=(2·64+2·25−a²)/4 → 84=178−a² → a²=94 → a=√94。"}, "rubric": {"items": [{"id": "median_formula", "description": "代入中线长公式", "score_weight": 0.5, "evidence_rule": "median_formula"}, {"id": "solve_side", "description": "解方程求 a", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"], "measurement_targets": [{"dim": "K_MEDIAN", "role": "primary", "evidence_rule": "rubric.median_formula"}, {"dim": "T_MEDIAN_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_SEG_016', 'K_MEDIAN', 'primary', 'rubric.median_formula'),
  ('tnt_dev00001', 'Q_SEG_016', 'T_MEDIAN_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_SEG_016', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_SEG_016', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_016', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_SEG_016', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_001', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_CIRCUMCIRCLE","K_SINE_RULE","T_CIRCUMCIRCLE_SOLVE"}', '{"K_CIRCUMCIRCLE","T_CIRCUMCIRCLE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_CIR_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，a=2√3，A=60°。求外接圆半径 R。", "stem_format": "open_solution", "answer": {"summary": "R = a/(2sinA) = 2√3/(2·√3/2) = 2。"}, "rubric": {"items": [{"id": "circumradius_formula", "description": "写出 R=a/(2sinA)", "score_weight": 0.5, "evidence_rule": "circumradius_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_CIRCUMCIRCLE", "K_SINE_RULE", "T_CIRCUMCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_CIRCUMCIRCLE", "role": "primary", "evidence_rule": "rubric.circumradius_formula"}, {"dim": "T_CIRCUMCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_001', 'K_CIRCUMCIRCLE', 'primary', 'rubric.circumradius_formula'),
  ('tnt_dev00001', 'Q_CIR_001', 'T_CIRCUMCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_001', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_001', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_001', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_001', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_002', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_CIRCUMCIRCLE","K_TRIANGLE_EXISTENCE","T_CIRCUMCIRCLE_SOLVE"}', '{"K_CIRCUMCIRCLE","T_CIRCUMCIRCLE_SOLVE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_CIR_002", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，b=6，B=90°。求外接圆半径 R。", "stem_format": "open_solution", "answer": {"summary": "B=90° → b 为直径 → R=3。"}, "rubric": {"items": [{"id": "diameter_angle", "description": "直角所对边为直径", "score_weight": 0.5, "evidence_rule": "diameter_angle"}, {"id": "compute_radius", "description": "求半径", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_CIRCUMCIRCLE", "K_TRIANGLE_EXISTENCE", "T_CIRCUMCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_CIRCUMCIRCLE", "role": "primary", "evidence_rule": "rubric.diameter_angle"}, {"dim": "T_CIRCUMCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_002', 'K_CIRCUMCIRCLE', 'primary', 'rubric.diameter_angle'),
  ('tnt_dev00001', 'Q_CIR_002', 'T_CIRCUMCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_002', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_002', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_002', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_002', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_003', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_CIRCUMCIRCLE","K_SINE_RULE","T_CIRCUMCIRCLE_SOLVE"}', '{"K_CIRCUMCIRCLE","T_CIRCUMCIRCLE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_CIR_003", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，c=2√2，C=45°。求外接圆半径 R。", "stem_format": "open_solution", "answer": {"summary": "R = c/(2sinC) = 2√2/(2·√2/2) = 2。"}, "rubric": {"items": [{"id": "circumradius_formula", "description": "写出 R=c/(2sinC)", "score_weight": 0.5, "evidence_rule": "circumradius_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_CIRCUMCIRCLE", "K_SINE_RULE", "T_CIRCUMCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_CIRCUMCIRCLE", "role": "primary", "evidence_rule": "rubric.circumradius_formula"}, {"dim": "T_CIRCUMCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_003', 'K_CIRCUMCIRCLE', 'primary', 'rubric.circumradius_formula'),
  ('tnt_dev00001', 'Q_CIR_003', 'T_CIRCUMCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_003', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_003', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_003', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_003', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_004', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_CIRCUMCIRCLE","K_TRIANGLE_AREA","T_CIRCUMCIRCLE_SOLVE"}', '{"K_CIRCUMCIRCLE","T_CIRCUMCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_004", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，A=30°，a=4。求外接圆面积。", "stem_format": "open_solution", "answer": {"summary": "R = 4/(2·½) = 4 → S=16π。"}, "rubric": {"items": [{"id": "circumradius_formula", "description": "求 R", "score_weight": 0.5, "evidence_rule": "circumradius_formula"}, {"id": "compute_area", "description": "圆面积公式", "score_weight": 0.5, "evidence_rule": "compute_area"}]}, "tags": ["K_CIRCUMCIRCLE", "K_TRIANGLE_AREA", "T_CIRCUMCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_CIRCUMCIRCLE", "role": "primary", "evidence_rule": "rubric.circumradius_formula"}, {"dim": "T_CIRCUMCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_area"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_004', 'K_CIRCUMCIRCLE', 'primary', 'rubric.circumradius_formula'),
  ('tnt_dev00001', 'Q_CIR_004', 'T_CIRCUMCIRCLE_SOLVE', 'secondary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_CIR_004', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_004', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_004', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_004', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_005', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_INCIRCLE","K_TRIANGLE_AREA","T_INCIRCLE_SOLVE"}', '{"K_INCIRCLE","T_INCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_005", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "直角△ABC 三边为 3，4，5。求内切圆半径 r。", "stem_format": "open_solution", "answer": {"summary": "S=6，s=6 → r=S/s=1。"}, "rubric": {"items": [{"id": "incircle_formula", "description": "写出 r=S/s", "score_weight": 0.5, "evidence_rule": "incircle_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_INCIRCLE", "role": "primary", "evidence_rule": "rubric.incircle_formula"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_005', 'K_INCIRCLE', 'primary', 'rubric.incircle_formula'),
  ('tnt_dev00001', 'Q_CIR_005', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_005', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_005', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_005', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_005', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_006', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_INCIRCLE","K_TRIANGLE_AREA","T_INCIRCLE_SOLVE"}', '{"K_INCIRCLE","T_INCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_006", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "边长为 6 的等边三角形，求内切圆半径 r。", "stem_format": "open_solution", "answer": {"summary": "S=9√3，s=9 → r=√3。"}, "rubric": {"items": [{"id": "incircle_formula", "description": "写出 r=S/s", "score_weight": 0.5, "evidence_rule": "incircle_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_INCIRCLE", "role": "primary", "evidence_rule": "rubric.incircle_formula"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_006', 'K_INCIRCLE', 'primary', 'rubric.incircle_formula'),
  ('tnt_dev00001', 'Q_CIR_006', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_006', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_006', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_006', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_006', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_007', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_INCIRCLE","K_TRIANGLE_AREA","T_INCIRCLE_SOLVE"}', '{"K_INCIRCLE","T_INCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_007", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "三角形面积为 12，内切圆半径 r=2。求周长。", "stem_format": "open_solution", "answer": {"summary": "r=S/s → s=6 → 周长 2s=12。"}, "rubric": {"items": [{"id": "incircle_formula", "description": "由 r=S/s 求半周长", "score_weight": 0.5, "evidence_rule": "incircle_formula"}, {"id": "compute_perimeter", "description": "求周长", "score_weight": 0.5, "evidence_rule": "compute_perimeter"}]}, "tags": ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_INCIRCLE", "role": "primary", "evidence_rule": "rubric.incircle_formula"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_perimeter"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_007', 'K_INCIRCLE', 'primary', 'rubric.incircle_formula'),
  ('tnt_dev00001', 'Q_CIR_007', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_perimeter'),
  ('tnt_dev00001', 'Q_CIR_007', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_007', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_007', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_007', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_008', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_RADIUS_RELATION","K_INCIRCLE","K_CIRCUMCIRCLE","T_INCIRCLE_SOLVE"}', '{"K_RADIUS_RELATION","T_INCIRCLE_SOLVE","K_CIRCUMCIRCLE"}', true, '{"question_id": "Q_CIR_008", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "等边三角形中，内切圆半径 r 与外接圆半径 R 的比值是多少？", "stem_format": "open_solution", "answer": {"summary": "R=a/√3，r=a/(2√3) → r:R=1:2。"}, "rubric": {"items": [{"id": "radius_relation", "description": "分别写出 R 与 r", "score_weight": 0.5, "evidence_rule": "radius_relation"}, {"id": "compute_ratio", "description": "求比值", "score_weight": 0.5, "evidence_rule": "compute_ratio"}]}, "tags": ["K_RADIUS_RELATION", "K_INCIRCLE", "K_CIRCUMCIRCLE", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_RADIUS_RELATION", "role": "primary", "evidence_rule": "rubric.radius_relation"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_ratio"}, {"dim": "K_CIRCUMCIRCLE", "role": "prerequisite", "evidence_rule": "probe.K_CIRCUMCIRCLE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_008', 'K_RADIUS_RELATION', 'primary', 'rubric.radius_relation'),
  ('tnt_dev00001', 'Q_CIR_008', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_ratio'),
  ('tnt_dev00001', 'Q_CIR_008', 'K_CIRCUMCIRCLE', 'prerequisite', 'probe.K_CIRCUMCIRCLE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_008', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_008', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_008', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_009', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_MULTI_TRIANGLE","K_TRIANGLE_AREA","T_MULTI_TRIANGLE"}', '{"K_MULTI_TRIANGLE","T_MULTI_TRIANGLE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_009", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，D 在 BC 上，∠BAD=30°，∠DAC=60°，AB=12，AD=8。求 AC。", "stem_format": "open_solution", "answer": {"summary": "S_ABC=S_ABD+S_ADC：½·12·AC·sin90° = ½·12·8·sin30° + ½·8·AC·sin60° → 6AC=24+2√3·AC → AC=6+2√3。"}, "rubric": {"items": [{"id": "area_split", "description": "整体面积等于两部分之和", "score_weight": 0.5, "evidence_rule": "area_split"}, {"id": "solve_side", "description": "解方程求 AC", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_MULTI_TRIANGLE", "K_TRIANGLE_AREA", "T_MULTI_TRIANGLE"], "measurement_targets": [{"dim": "K_MULTI_TRIANGLE", "role": "primary", "evidence_rule": "rubric.area_split"}, {"dim": "T_MULTI_TRIANGLE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_009', 'K_MULTI_TRIANGLE', 'primary', 'rubric.area_split'),
  ('tnt_dev00001', 'Q_CIR_009', 'T_MULTI_TRIANGLE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_CIR_009', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_009', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_009', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_009', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_010', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_COMMON_EDGE","K_COSINE_RULE","T_COMMON_EDGE"}', '{"K_COMMON_EDGE","T_COMMON_EDGE","K_COSINE_RULE"}', true, '{"question_id": "Q_CIR_010", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "△ABC 与 △DBC 共边 BC。A=60°，AB=8，AC=5，D=90° 且 BD=DC。求 BC。", "stem_format": "open_solution", "answer": {"summary": "BC²=64+25−80·(1/2)=49 → BC=7；△DBC 为等腰直角 → BD=DC=7/√2。"}, "rubric": {"items": [{"id": "cosine_apply", "description": "在△ABC 中用余弦定理求 BC", "score_weight": 0.5, "evidence_rule": "cosine_apply"}, {"id": "right_triangle", "description": "在直角△DBC 中求腰长", "score_weight": 0.5, "evidence_rule": "right_triangle"}]}, "tags": ["K_COMMON_EDGE", "K_COSINE_RULE", "T_COMMON_EDGE"], "measurement_targets": [{"dim": "K_COMMON_EDGE", "role": "primary", "evidence_rule": "rubric.cosine_apply"}, {"dim": "T_COMMON_EDGE", "role": "secondary", "evidence_rule": "rubric.right_triangle"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_010', 'K_COMMON_EDGE', 'primary', 'rubric.cosine_apply'),
  ('tnt_dev00001', 'Q_CIR_010', 'T_COMMON_EDGE', 'secondary', 'rubric.right_triangle'),
  ('tnt_dev00001', 'Q_CIR_010', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_010', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_010', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_010', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_011', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_CIRCUMCIRCLE","K_TRIANGLE_AREA","T_CIRCUMCIRCLE_SOLVE"}', '{"K_CIRCUMCIRCLE","T_CIRCUMCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_011", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，A=60°，b=4，c=6。求面积与外接圆半径。", "stem_format": "open_solution", "answer": {"summary": "S=½·4·6·sin60°=6√3；a²=16+36−48·½=28 → a=2√7 → R=a/(2sin60°)=2√21/3。"}, "rubric": {"items": [{"id": "compute_area", "description": "面积公式", "score_weight": 0.5, "evidence_rule": "compute_area"}, {"id": "circumradius_formula", "description": "求 a 后算 R", "score_weight": 0.5, "evidence_rule": "circumradius_formula"}]}, "tags": ["K_CIRCUMCIRCLE", "K_TRIANGLE_AREA", "T_CIRCUMCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_CIRCUMCIRCLE", "role": "primary", "evidence_rule": "rubric.compute_area"}, {"dim": "T_CIRCUMCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.circumradius_formula"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_011', 'K_CIRCUMCIRCLE', 'primary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_CIR_011', 'T_CIRCUMCIRCLE_SOLVE', 'secondary', 'rubric.circumradius_formula'),
  ('tnt_dev00001', 'Q_CIR_011', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_011', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_011', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_011', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_012', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_INCIRCLE","K_TRIANGLE_AREA","T_INCIRCLE_SOLVE"}', '{"K_INCIRCLE","T_INCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "直角三角形两直角边为 6，8。求内切圆半径 r。", "stem_format": "open_solution", "answer": {"summary": "斜边 10，S=24，s=12 → r=2。"}, "rubric": {"items": [{"id": "incircle_formula", "description": "写出 r=S/s", "score_weight": 0.5, "evidence_rule": "incircle_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_INCIRCLE", "role": "primary", "evidence_rule": "rubric.incircle_formula"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_012', 'K_INCIRCLE', 'primary', 'rubric.incircle_formula'),
  ('tnt_dev00001', 'Q_CIR_012', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_012', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_013', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_MULTI_TRIANGLE","K_EQUAL_AREA","T_MULTI_TRIANGLE"}', '{"K_MULTI_TRIANGLE","T_MULTI_TRIANGLE","K_EQUAL_AREA"}', true, '{"question_id": "Q_CIR_013", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "在△ABC中，AD 为 BC 边上的中线。比较 S_△ABD 与 S_△ADC。", "stem_format": "open_solution", "answer": {"summary": "BD=DC 且两三角形等高 → 面积相等。"}, "rubric": {"items": [{"id": "area_split", "description": "底边与高对应", "score_weight": 0.5, "evidence_rule": "area_split"}, {"id": "conclude", "description": "下结论并说明理由", "score_weight": 0.5, "evidence_rule": "conclude"}]}, "tags": ["K_MULTI_TRIANGLE", "K_EQUAL_AREA", "T_MULTI_TRIANGLE"], "measurement_targets": [{"dim": "K_MULTI_TRIANGLE", "role": "primary", "evidence_rule": "rubric.area_split"}, {"dim": "T_MULTI_TRIANGLE", "role": "secondary", "evidence_rule": "rubric.conclude"}, {"dim": "K_EQUAL_AREA", "role": "prerequisite", "evidence_rule": "probe.K_EQUAL_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_013', 'K_MULTI_TRIANGLE', 'primary', 'rubric.area_split'),
  ('tnt_dev00001', 'Q_CIR_013', 'T_MULTI_TRIANGLE', 'secondary', 'rubric.conclude'),
  ('tnt_dev00001', 'Q_CIR_013', 'K_EQUAL_AREA', 'prerequisite', 'probe.K_EQUAL_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_013', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_013', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_013', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_014', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_HIDDEN_CIRCLE","K_CIRCUMCIRCLE","T_POWER_AND_CIRCLE"}', '{"K_HIDDEN_CIRCLE","T_POWER_AND_CIRCLE","K_CIRCUMCIRCLE"}', true, '{"question_id": "Q_CIR_014", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "四边形 ABCD 中，∠ABC=∠ADC=90°，AB=3，BC=4。求 A、B、C、D 四点所在圆的面积。", "stem_format": "open_solution", "answer": {"summary": "∠ABC=∠ADC=90° → 四点共圆，AC 为直径；AC=5 → S=25π/4。"}, "rubric": {"items": [{"id": "cyclic_detect", "description": "由对角互补识别共圆", "score_weight": 0.5, "evidence_rule": "cyclic_detect"}, {"id": "compute_area", "description": "直径求圆面积", "score_weight": 0.5, "evidence_rule": "compute_area"}]}, "tags": ["K_HIDDEN_CIRCLE", "K_CIRCUMCIRCLE", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_HIDDEN_CIRCLE", "role": "primary", "evidence_rule": "rubric.cyclic_detect"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.compute_area"}, {"dim": "K_CIRCUMCIRCLE", "role": "prerequisite", "evidence_rule": "probe.K_CIRCUMCIRCLE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_014', 'K_HIDDEN_CIRCLE', 'primary', 'rubric.cyclic_detect'),
  ('tnt_dev00001', 'Q_CIR_014', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_CIR_014', 'K_CIRCUMCIRCLE', 'prerequisite', 'probe.K_CIRCUMCIRCLE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_014', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_014', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_014', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_015', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_COMMON_EDGE","K_CIRCUMCIRCLE","T_COMMON_EDGE"}', '{"K_COMMON_EDGE","T_COMMON_EDGE","K_CIRCUMCIRCLE"}', true, '{"question_id": "Q_CIR_015", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "圆内接四边形 ABCD 中，BD 为直径，BD=10，∠BCD=30°。求 BC。", "stem_format": "open_solution", "answer": {"summary": "BD 为直径 → ∠BCD 所对弧为半圆 → ∠BCD=30° → BC=BD·cos30°=5√3。"}, "rubric": {"items": [{"id": "diameter_angle", "description": "直径所对圆周角为直角", "score_weight": 0.5, "evidence_rule": "diameter_angle"}, {"id": "solve_side", "description": "直角三角形求 BC", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_COMMON_EDGE", "K_CIRCUMCIRCLE", "T_COMMON_EDGE"], "measurement_targets": [{"dim": "K_COMMON_EDGE", "role": "primary", "evidence_rule": "rubric.diameter_angle"}, {"dim": "T_COMMON_EDGE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_CIRCUMCIRCLE", "role": "prerequisite", "evidence_rule": "probe.K_CIRCUMCIRCLE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_015', 'K_COMMON_EDGE', 'primary', 'rubric.diameter_angle'),
  ('tnt_dev00001', 'Q_CIR_015', 'T_COMMON_EDGE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_CIR_015', 'K_CIRCUMCIRCLE', 'prerequisite', 'probe.K_CIRCUMCIRCLE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_015', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_015', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_015', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_CIR_016', 'tnt_dev00001', 'chap_03', 1, 'open_solution', '{"K_INCIRCLE","K_TRIANGLE_AREA","T_INCIRCLE_SOLVE"}', '{"K_INCIRCLE","T_INCIRCLE_SOLVE","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_CIR_016", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "question_version": 1, "stem_markdown": "三角形三边为 13，14，15。求内切圆半径 r。", "stem_format": "open_solution", "answer": {"summary": "S=84，s=21 → r=4。"}, "rubric": {"items": [{"id": "incircle_formula", "description": "求面积与半周长", "score_weight": 0.5, "evidence_rule": "incircle_formula"}, {"id": "compute_radius", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"], "measurement_targets": [{"dim": "K_INCIRCLE", "role": "primary", "evidence_rule": "rubric.incircle_formula"}, {"dim": "T_INCIRCLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_CIR_016', 'K_INCIRCLE', 'primary', 'rubric.incircle_formula'),
  ('tnt_dev00001', 'Q_CIR_016', 'T_INCIRCLE_SOLVE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_CIR_016', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_CIR_016', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_016', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_CIR_016', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_001', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_ANGLE_TO_SIDE","K_SINE_RULE","T_ANGLE_SOLVE"}', '{"K_ANGLE_TO_SIDE","T_ANGLE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，sinA:sinB:sinC = 3:4:5。求最大角。", "stem_format": "open_solution", "answer": {"summary": "a:b:c=3:4:5 → 5²=3²+4² → 直角，最大角 90°。"}, "rubric": {"items": [{"id": "sine_to_side", "description": "正弦比化为边比", "score_weight": 0.5, "evidence_rule": "sine_to_side"}, {"id": "solve_angle", "description": "由勾股逆定理定角", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_ANGLE_TO_SIDE", "K_SINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_ANGLE_TO_SIDE", "role": "primary", "evidence_rule": "rubric.sine_to_side"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_001', 'K_ANGLE_TO_SIDE', 'primary', 'rubric.sine_to_side'),
  ('tnt_dev00001', 'Q_EXT_001', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_EXT_001', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_001', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_001', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_001', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_002', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_SIDE_TO_ANGLE","K_COSINE_RULE","T_ANGLE_SOLVE"}', '{"K_SIDE_TO_ANGLE","T_ANGLE_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_002", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a²=b²+c²−√3·bc。求角 A。", "stem_format": "open_solution", "answer": {"summary": "cosA=(b²+c²−a²)/(2bc)=√3/2 → A=30°。"}, "rubric": {"items": [{"id": "cosine_apply", "description": "由条件求 cosA", "score_weight": 0.5, "evidence_rule": "cosine_apply"}, {"id": "solve_angle", "description": "求出角 A", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_SIDE_TO_ANGLE", "K_COSINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_SIDE_TO_ANGLE", "role": "primary", "evidence_rule": "rubric.cosine_apply"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_002', 'K_SIDE_TO_ANGLE', 'primary', 'rubric.cosine_apply'),
  ('tnt_dev00001', 'Q_EXT_002', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_EXT_002', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_002', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_002', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_002', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_003', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_INEQUALITY","K_COSINE_RULE","T_INEQUALITY_APPLY"}', '{"K_INEQUALITY","T_INEQUALITY_APPLY","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_003", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a+b=8，C=60°。求边 c 的最小值。", "stem_format": "open_solution", "answer": {"summary": "c²=a²+b²−ab=(a+b)²−3ab ≥ 64−3·16=16 → c≥4，a=b=4 时取等 → c_min=4。"}, "rubric": {"items": [{"id": "cosine_expand", "description": "用余弦定理展开 c²", "score_weight": 0.5, "evidence_rule": "cosine_expand"}, {"id": "inequality_apply", "description": "基本不等式求下界并验证取等", "score_weight": 0.5, "evidence_rule": "inequality_apply"}]}, "tags": ["K_INEQUALITY", "K_COSINE_RULE", "T_INEQUALITY_APPLY"], "measurement_targets": [{"dim": "K_INEQUALITY", "role": "primary", "evidence_rule": "rubric.cosine_expand"}, {"dim": "T_INEQUALITY_APPLY", "role": "secondary", "evidence_rule": "rubric.inequality_apply"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_003', 'K_INEQUALITY', 'primary', 'rubric.cosine_expand'),
  ('tnt_dev00001', 'Q_EXT_003', 'T_INEQUALITY_APPLY', 'secondary', 'rubric.inequality_apply'),
  ('tnt_dev00001', 'Q_EXT_003', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_003', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_003', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_003', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_004', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_INEQUALITY","K_TRIANGLE_AREA","T_INEQUALITY_APPLY"}', '{"K_INEQUALITY","T_INEQUALITY_APPLY","K_TRIANGLE_AREA"}', true, '{"question_id": "Q_EXT_004", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a+b=10，C=60°。求面积 S 的最大值。", "stem_format": "open_solution", "answer": {"summary": "S=½ab·sin60°=√3ab/4 ≤ √3/4·25 = 25√3/4，a=b=5 取等。"}, "rubric": {"items": [{"id": "area_expression", "description": "面积用 ab 表达", "score_weight": 0.5, "evidence_rule": "area_expression"}, {"id": "inequality_apply", "description": "ab 上界并验证取等", "score_weight": 0.5, "evidence_rule": "inequality_apply"}]}, "tags": ["K_INEQUALITY", "K_TRIANGLE_AREA", "T_INEQUALITY_APPLY"], "measurement_targets": [{"dim": "K_INEQUALITY", "role": "primary", "evidence_rule": "rubric.area_expression"}, {"dim": "T_INEQUALITY_APPLY", "role": "secondary", "evidence_rule": "rubric.inequality_apply"}, {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_004', 'K_INEQUALITY', 'primary', 'rubric.area_expression'),
  ('tnt_dev00001', 'Q_EXT_004', 'T_INEQUALITY_APPLY', 'secondary', 'rubric.inequality_apply'),
  ('tnt_dev00001', 'Q_EXT_004', 'K_TRIANGLE_AREA', 'prerequisite', 'probe.K_TRIANGLE_AREA')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_004', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_004', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_004', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_005', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_TRIG_RANGE","K_SINE_RULE","T_TRIG_FUNC_RANGE"}', '{"K_TRIG_RANGE","T_TRIG_FUNC_RANGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_005", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a=2，A=60°。求周长 p 的取值范围。", "stem_format": "open_solution", "answer": {"summary": "b+c=(4/√3)(sinB+sinC)=4cos((B−C)/2) ∈ (2,4] → p ∈ (4,6]。"}, "rubric": {"items": [{"id": "sine_express", "description": "边化角表达周长", "score_weight": 0.5, "evidence_rule": "sine_express"}, {"id": "trig_range", "description": "和差化积求范围", "score_weight": 0.5, "evidence_rule": "trig_range"}]}, "tags": ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"], "measurement_targets": [{"dim": "K_TRIG_RANGE", "role": "primary", "evidence_rule": "rubric.sine_express"}, {"dim": "T_TRIG_FUNC_RANGE", "role": "secondary", "evidence_rule": "rubric.trig_range"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_005', 'K_TRIG_RANGE', 'primary', 'rubric.sine_express'),
  ('tnt_dev00001', 'Q_EXT_005', 'T_TRIG_FUNC_RANGE', 'secondary', 'rubric.trig_range'),
  ('tnt_dev00001', 'Q_EXT_005', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_005', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_005', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_005', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_006', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_EDGE_RANGE","K_SINE_RULE","T_TRIG_FUNC_RANGE"}', '{"K_EDGE_RANGE","T_TRIG_FUNC_RANGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_006", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，c=2，C=60°。求 a+b 的取值范围。", "stem_format": "open_solution", "answer": {"summary": "a+b=(2/sin60°)(sinA+sinB)=4cos((A−B)/2) ∈ (2,4]。"}, "rubric": {"items": [{"id": "sine_express", "description": "边化角表达 a+b", "score_weight": 0.5, "evidence_rule": "sine_express"}, {"id": "trig_range", "description": "求范围并说明开闭", "score_weight": 0.5, "evidence_rule": "trig_range"}]}, "tags": ["K_EDGE_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"], "measurement_targets": [{"dim": "K_EDGE_RANGE", "role": "primary", "evidence_rule": "rubric.sine_express"}, {"dim": "T_TRIG_FUNC_RANGE", "role": "secondary", "evidence_rule": "rubric.trig_range"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_006', 'K_EDGE_RANGE', 'primary', 'rubric.sine_express'),
  ('tnt_dev00001', 'Q_EXT_006', 'T_TRIG_FUNC_RANGE', 'secondary', 'rubric.trig_range'),
  ('tnt_dev00001', 'Q_EXT_006', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_006', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_006', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_006', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_007', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_TRIG_RANGE","K_SINE_RULE","T_TRIG_FUNC_RANGE"}', '{"K_TRIG_RANGE","T_TRIG_FUNC_RANGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_007", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，A=60°。求 2sinB+2sinC 的最大值。", "stem_format": "open_solution", "answer": {"summary": "B+C=120° → sinB+sinC=√3·cos((B−C)/2) ≤ √3 → 最大值 2√3（B=C=60°）。"}, "rubric": {"items": [{"id": "sum_to_product", "description": "和差化积", "score_weight": 0.5, "evidence_rule": "sum_to_product"}, {"id": "trig_range", "description": "由 cos≤1 求最大值", "score_weight": 0.5, "evidence_rule": "trig_range"}]}, "tags": ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"], "measurement_targets": [{"dim": "K_TRIG_RANGE", "role": "primary", "evidence_rule": "rubric.sum_to_product"}, {"dim": "T_TRIG_FUNC_RANGE", "role": "secondary", "evidence_rule": "rubric.trig_range"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_007', 'K_TRIG_RANGE', 'primary', 'rubric.sum_to_product'),
  ('tnt_dev00001', 'Q_EXT_007', 'T_TRIG_FUNC_RANGE', 'secondary', 'rubric.trig_range'),
  ('tnt_dev00001', 'Q_EXT_007', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_007', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_007', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_007', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_008', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_EDGE_RANGE","K_COSINE_RULE","T_INEQUALITY_APPLY"}', '{"K_EDGE_RANGE","T_INEQUALITY_APPLY","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_008", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a²+b²−ab=c²。求 (a+b)/c 的最大值。", "stem_format": "open_solution", "answer": {"summary": "令 t=a/b：((a+b)/c)²=(t²+2t+1)/(t²−t+1) ≤ 4（t=1 时取等）→ 最大值 2（等边）。"}, "rubric": {"items": [{"id": "ratio_square", "description": "把比值平方并换元", "score_weight": 0.5, "evidence_rule": "ratio_square"}, {"id": "inequality_apply", "description": "求上界并验证取等", "score_weight": 0.5, "evidence_rule": "inequality_apply"}]}, "tags": ["K_EDGE_RANGE", "K_COSINE_RULE", "T_INEQUALITY_APPLY"], "measurement_targets": [{"dim": "K_EDGE_RANGE", "role": "primary", "evidence_rule": "rubric.ratio_square"}, {"dim": "T_INEQUALITY_APPLY", "role": "secondary", "evidence_rule": "rubric.inequality_apply"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_008', 'K_EDGE_RANGE', 'primary', 'rubric.ratio_square'),
  ('tnt_dev00001', 'Q_EXT_008', 'T_INEQUALITY_APPLY', 'secondary', 'rubric.inequality_apply'),
  ('tnt_dev00001', 'Q_EXT_008', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_008', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_008', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_008', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_009', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_INEQUALITY","K_COSINE_RULE","T_MAX_MIN"}', '{"K_INEQUALITY","T_MAX_MIN","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_009", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a+b+c=6，C=60°。求面积 S 的最大值。", "stem_format": "open_solution", "answer": {"summary": "S=√3ab/4；c²=a²+b²−ab ≥ (a+b)²/4 → c≥2，a=b=2 时取等 → S_max=√3。"}, "rubric": {"items": [{"id": "area_expression", "description": "面积用 ab 表达", "score_weight": 0.5, "evidence_rule": "area_expression"}, {"id": "inequality_apply", "description": "由余弦与不等式求上界", "score_weight": 0.5, "evidence_rule": "inequality_apply"}]}, "tags": ["K_INEQUALITY", "K_COSINE_RULE", "T_MAX_MIN"], "measurement_targets": [{"dim": "K_INEQUALITY", "role": "primary", "evidence_rule": "rubric.inequality_apply"}, {"dim": "T_MAX_MIN", "role": "secondary", "evidence_rule": "rubric.area_expression"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_009', 'K_INEQUALITY', 'primary', 'rubric.inequality_apply'),
  ('tnt_dev00001', 'Q_EXT_009', 'T_MAX_MIN', 'secondary', 'rubric.area_expression'),
  ('tnt_dev00001', 'Q_EXT_009', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_009', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_009', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_009', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_010', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_EDGE_RANGE","K_SINE_RULE","T_TRIG_FUNC_RANGE"}', '{"K_EDGE_RANGE","T_TRIG_FUNC_RANGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_010", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，b=2，B=60°。求 a+c 的取值范围。", "stem_format": "open_solution", "answer": {"summary": "a+c=(2/sin60°)(sinA+sinC)=4cos((A−C)/2) ∈ (2,4]。"}, "rubric": {"items": [{"id": "sine_express", "description": "边化角表达 a+c", "score_weight": 0.5, "evidence_rule": "sine_express"}, {"id": "trig_range", "description": "求范围并说明开闭", "score_weight": 0.5, "evidence_rule": "trig_range"}]}, "tags": ["K_EDGE_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"], "measurement_targets": [{"dim": "K_EDGE_RANGE", "role": "primary", "evidence_rule": "rubric.sine_express"}, {"dim": "T_TRIG_FUNC_RANGE", "role": "secondary", "evidence_rule": "rubric.trig_range"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_010', 'K_EDGE_RANGE', 'primary', 'rubric.sine_express'),
  ('tnt_dev00001', 'Q_EXT_010', 'T_TRIG_FUNC_RANGE', 'secondary', 'rubric.trig_range'),
  ('tnt_dev00001', 'Q_EXT_010', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_010', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_010', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_010', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_011', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_SIDE_TO_ANGLE","K_COSINE_RULE","T_ANGLE_SOLVE"}', '{"K_SIDE_TO_ANGLE","T_ANGLE_SOLVE","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_011", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a·cosC + c·cosA = 3。求边 b。", "stem_format": "open_solution", "answer": {"summary": "a·cosC+c·cosA = b（投影定理）→ b=3。"}, "rubric": {"items": [{"id": "projection_apply", "description": "识别投影定理", "score_weight": 0.5, "evidence_rule": "projection_apply"}, {"id": "solve_side", "description": "由恒等式求 b", "score_weight": 0.5, "evidence_rule": "solve_side"}]}, "tags": ["K_SIDE_TO_ANGLE", "K_COSINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_SIDE_TO_ANGLE", "role": "primary", "evidence_rule": "rubric.projection_apply"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.solve_side"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_011', 'K_SIDE_TO_ANGLE', 'primary', 'rubric.projection_apply'),
  ('tnt_dev00001', 'Q_EXT_011', 'T_ANGLE_SOLVE', 'secondary', 'rubric.solve_side'),
  ('tnt_dev00001', 'Q_EXT_011', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_011', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_011', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_011', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_012', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_EDGE_RANGE","K_COSINE_RULE","T_MAX_MIN"}', '{"K_EDGE_RANGE","T_MAX_MIN","K_COSINE_RULE"}', true, '{"question_id": "Q_EXT_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a+b=8，C=120°。求边 c 的取值范围。", "stem_format": "open_solution", "answer": {"summary": "c²=(a+b)²−ab=64−ab ∈ (0,48] → 4√3 ≤ c < 8（a=b=4 时 c=4√3，ab→0 时 c→8）。"}, "rubric": {"items": [{"id": "cosine_expand", "description": "余弦定理展开 c²", "score_weight": 0.5, "evidence_rule": "cosine_expand"}, {"id": "range_solve", "description": "由 ab 范围求 c 范围", "score_weight": 0.5, "evidence_rule": "range_solve"}]}, "tags": ["K_EDGE_RANGE", "K_COSINE_RULE", "T_MAX_MIN"], "measurement_targets": [{"dim": "K_EDGE_RANGE", "role": "primary", "evidence_rule": "rubric.cosine_expand"}, {"dim": "T_MAX_MIN", "role": "secondary", "evidence_rule": "rubric.range_solve"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_012', 'K_EDGE_RANGE', 'primary', 'rubric.cosine_expand'),
  ('tnt_dev00001', 'Q_EXT_012', 'T_MAX_MIN', 'secondary', 'rubric.range_solve'),
  ('tnt_dev00001', 'Q_EXT_012', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_013', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_TRIANGLE_EXISTENCE","K_TRIG_RANGE","T_ANGLE_SOLVE"}', '{"K_TRIANGLE_EXISTENCE","T_ANGLE_SOLVE","K_TRIG_RANGE"}', true, '{"question_id": "Q_EXT_013", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，A=30°。求角 B 的取值范围使三角形存在。", "stem_format": "open_solution", "answer": {"summary": "C=150°−B>0 且 B>0 → B ∈ (0°,150°)。"}, "rubric": {"items": [{"id": "existence_setup", "description": "由内角和列约束", "score_weight": 0.5, "evidence_rule": "existence_setup"}, {"id": "range_solve", "description": "写出 B 的范围", "score_weight": 0.5, "evidence_rule": "range_solve"}]}, "tags": ["K_TRIANGLE_EXISTENCE", "K_TRIG_RANGE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_TRIANGLE_EXISTENCE", "role": "primary", "evidence_rule": "rubric.existence_setup"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.range_solve"}, {"dim": "K_TRIG_RANGE", "role": "prerequisite", "evidence_rule": "probe.K_TRIG_RANGE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_013', 'K_TRIANGLE_EXISTENCE', 'primary', 'rubric.existence_setup'),
  ('tnt_dev00001', 'Q_EXT_013', 'T_ANGLE_SOLVE', 'secondary', 'rubric.range_solve'),
  ('tnt_dev00001', 'Q_EXT_013', 'K_TRIG_RANGE', 'prerequisite', 'probe.K_TRIG_RANGE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_013', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_013', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_013', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_014', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_TRIANGLE_AREA","K_INEQUALITY","T_MAX_MIN"}', '{"K_TRIANGLE_AREA","T_MAX_MIN","K_INEQUALITY"}', true, '{"question_id": "Q_EXT_014", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，a=2，A=60°。求面积 S 的最大值。", "stem_format": "open_solution", "answer": {"summary": "b+c ≤ 4（Q_EXT_010 同构），S=½bc·sin60° ≤ ½·4·(√3/2)=√3，b=c=2 取等。"}, "rubric": {"items": [{"id": "area_expression", "description": "面积用 bc 表达", "score_weight": 0.5, "evidence_rule": "area_expression"}, {"id": "inequality_apply", "description": "bc 上界并验证取等", "score_weight": 0.5, "evidence_rule": "inequality_apply"}]}, "tags": ["K_TRIANGLE_AREA", "K_INEQUALITY", "T_MAX_MIN"], "measurement_targets": [{"dim": "K_TRIANGLE_AREA", "role": "primary", "evidence_rule": "rubric.area_expression"}, {"dim": "T_MAX_MIN", "role": "secondary", "evidence_rule": "rubric.inequality_apply"}, {"dim": "K_INEQUALITY", "role": "prerequisite", "evidence_rule": "probe.K_INEQUALITY"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_014', 'K_TRIANGLE_AREA', 'primary', 'rubric.area_expression'),
  ('tnt_dev00001', 'Q_EXT_014', 'T_MAX_MIN', 'secondary', 'rubric.inequality_apply'),
  ('tnt_dev00001', 'Q_EXT_014', 'K_INEQUALITY', 'prerequisite', 'probe.K_INEQUALITY')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_014', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_014', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_014', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_015', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_SIDE_TO_ANGLE","K_SINE_RULE","T_SHAPE_JUDGE"}', '{"K_SIDE_TO_ANGLE","T_SHAPE_JUDGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_015", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，sin²A+sin²B=sin²C。求角 C。", "stem_format": "open_solution", "answer": {"summary": "边化角：a²+b²=c² → C=90°。"}, "rubric": {"items": [{"id": "sine_to_side", "description": "正弦比化为边比", "score_weight": 0.5, "evidence_rule": "sine_to_side"}, {"id": "solve_angle", "description": "勾股逆定理定角", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_SIDE_TO_ANGLE", "K_SINE_RULE", "T_SHAPE_JUDGE"], "measurement_targets": [{"dim": "K_SIDE_TO_ANGLE", "role": "primary", "evidence_rule": "rubric.sine_to_side"}, {"dim": "T_SHAPE_JUDGE", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_015', 'K_SIDE_TO_ANGLE', 'primary', 'rubric.sine_to_side'),
  ('tnt_dev00001', 'Q_EXT_015', 'T_SHAPE_JUDGE', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_EXT_015', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_015', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_015', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_015', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_EXT_016', 'tnt_dev00001', 'chap_04', 1, 'open_solution', '{"K_TRIG_RANGE","K_SINE_RULE","T_TRIG_FUNC_RANGE"}', '{"K_TRIG_RANGE","T_TRIG_FUNC_RANGE","K_SINE_RULE"}', true, '{"question_id": "Q_EXT_016", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "question_version": 1, "stem_markdown": "在△ABC中，B+C=120°。求 sinB+sinC 的最大值。", "stem_format": "open_solution", "answer": {"summary": "sinB+sinC=2sin60°·cos((B−C)/2)=√3·cos((B−C)/2) ≤ √3，B=C=60° 取等。"}, "rubric": {"items": [{"id": "sum_to_product", "description": "和差化积", "score_weight": 0.5, "evidence_rule": "sum_to_product"}, {"id": "trig_range", "description": "求最大值并给出取等条件", "score_weight": 0.5, "evidence_rule": "trig_range"}]}, "tags": ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"], "measurement_targets": [{"dim": "K_TRIG_RANGE", "role": "primary", "evidence_rule": "rubric.sum_to_product"}, {"dim": "T_TRIG_FUNC_RANGE", "role": "secondary", "evidence_rule": "rubric.trig_range"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_EXT_016', 'K_TRIG_RANGE', 'primary', 'rubric.sum_to_product'),
  ('tnt_dev00001', 'Q_EXT_016', 'T_TRIG_FUNC_RANGE', 'secondary', 'rubric.trig_range'),
  ('tnt_dev00001', 'Q_EXT_016', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_EXT_016', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_016', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_EXT_016', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_001', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY"}', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY","K_SINE_RULE"}', true, '{"question_id": "Q_THE_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，A=45°，B=60°。求角 C。", "stem_format": "open_solution", "answer": {"summary": "tanC = −tan(A+B) = −(1+√3)/(1−√3) = 2+√3 → C=75°。"}, "rubric": {"items": [{"id": "tangent_identity", "description": "正切和角公式求 tanC", "score_weight": 0.5, "evidence_rule": "tangent_identity"}, {"id": "solve_angle", "description": "反解角 C", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"], "measurement_targets": [{"dim": "K_TANGENT_IDENTITY", "role": "primary", "evidence_rule": "rubric.tangent_identity"}, {"dim": "T_TANGENT_IDENTITY", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_001', 'K_TANGENT_IDENTITY', 'primary', 'rubric.tangent_identity'),
  ('tnt_dev00001', 'Q_THE_001', 'T_TANGENT_IDENTITY', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_THE_001', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_001', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_001', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_001', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_002', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY"}', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_THE_002", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，tanA=2，tanB=3。求角 C。", "stem_format": "open_solution", "answer": {"summary": "tanC = −(tanA+tanB)/(1−tanA·tanB) = −5/(1−6) = 1 → C=45°。"}, "rubric": {"items": [{"id": "tangent_identity", "description": "正切和角公式", "score_weight": 0.5, "evidence_rule": "tangent_identity"}, {"id": "solve_angle", "description": "求 C", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"], "measurement_targets": [{"dim": "K_TANGENT_IDENTITY", "role": "primary", "evidence_rule": "rubric.tangent_identity"}, {"dim": "T_TANGENT_IDENTITY", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_002', 'K_TANGENT_IDENTITY', 'primary', 'rubric.tangent_identity'),
  ('tnt_dev00001', 'Q_THE_002', 'T_TANGENT_IDENTITY', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_THE_002', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_002', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_002', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_002', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_003', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_SINE_SQUARE_DIFF","K_SINE_RULE","T_ANGLE_SOLVE"}', '{"K_SINE_SQUARE_DIFF","T_ANGLE_SOLVE","K_SINE_RULE"}', true, '{"question_id": "Q_THE_003", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，A=60°，B=45°。求 sin²A−sin²B 的值。", "stem_format": "open_solution", "answer": {"summary": "sin²A−sin²B = sin(A+B)·sin(A−B) = sin105°·sin15° = ((√6+√2)/4)·((√6−√2)/4) = 1/4。"}, "rubric": {"items": [{"id": "square_diff", "description": "正弦平方差公式", "score_weight": 0.5, "evidence_rule": "square_diff"}, {"id": "compute_value", "description": "代入求值", "score_weight": 0.5, "evidence_rule": "compute_value"}]}, "tags": ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_ANGLE_SOLVE"], "measurement_targets": [{"dim": "K_SINE_SQUARE_DIFF", "role": "primary", "evidence_rule": "rubric.square_diff"}, {"dim": "T_ANGLE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_value"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_003', 'K_SINE_SQUARE_DIFF', 'primary', 'rubric.square_diff'),
  ('tnt_dev00001', 'Q_THE_003', 'T_ANGLE_SOLVE', 'secondary', 'rubric.compute_value'),
  ('tnt_dev00001', 'Q_THE_003', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_003', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_003', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_003', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_004', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_SINE_SQUARE_DIFF","K_SINE_RULE","T_SHAPE_JUDGE"}', '{"K_SINE_SQUARE_DIFF","T_SHAPE_JUDGE","K_SINE_RULE"}', true, '{"question_id": "Q_THE_004", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，sin²A−sin²B=sin²C。判断三角形形状。", "stem_format": "open_solution", "answer": {"summary": "sin(A+B)·sin(A−B)=sin²C → sinC·sin(A−B)=sin²C → sin(A−B)=sinC → A−B=C 或 A−B=180°−C；前者 A=90°（直角），后者 A=90°+... 由 B+C<180° 排除 → A=90°。"}, "rubric": {"items": [{"id": "square_diff", "description": "正弦平方差展开", "score_weight": 0.5, "evidence_rule": "square_diff"}, {"id": "conclude_shape", "description": "化简并判断形状", "score_weight": 0.5, "evidence_rule": "conclude_shape"}]}, "tags": ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_SHAPE_JUDGE"], "measurement_targets": [{"dim": "K_SINE_SQUARE_DIFF", "role": "primary", "evidence_rule": "rubric.square_diff"}, {"dim": "T_SHAPE_JUDGE", "role": "secondary", "evidence_rule": "rubric.conclude_shape"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_004', 'K_SINE_SQUARE_DIFF', 'primary', 'rubric.square_diff'),
  ('tnt_dev00001', 'Q_THE_004', 'T_SHAPE_JUDGE', 'secondary', 'rubric.conclude_shape'),
  ('tnt_dev00001', 'Q_THE_004', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_004', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_004', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_004', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_005', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE"}', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_005", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "圆内两弦 AB、CD 交于 P，PA=3，PB=6，PC=2。求 PD。", "stem_format": "open_solution", "answer": {"summary": "相交弦定理：PA·PB=PC·PD → PD = 3·6/2 = 9。"}, "rubric": {"items": [{"id": "power_theorem", "description": "写出相交弦定理", "score_weight": 0.5, "evidence_rule": "power_theorem"}, {"id": "solve_length", "description": "代入求 PD", "score_weight": 0.5, "evidence_rule": "solve_length"}]}, "tags": ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_POWER_OF_POINT", "role": "primary", "evidence_rule": "rubric.power_theorem"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.solve_length"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_005', 'K_POWER_OF_POINT', 'primary', 'rubric.power_theorem'),
  ('tnt_dev00001', 'Q_THE_005', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.solve_length'),
  ('tnt_dev00001', 'Q_THE_005', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_005', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_005', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_005', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_006', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE"}', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_006", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "从圆外一点 P 引切线 PT 与割线 PAB，PA=4，PB=9。求切线长 PT。", "stem_format": "open_solution", "answer": {"summary": "切割线定理：PT²=PA·PB=36 → PT=6。"}, "rubric": {"items": [{"id": "power_theorem", "description": "写出切割线定理", "score_weight": 0.5, "evidence_rule": "power_theorem"}, {"id": "solve_length", "description": "求 PT", "score_weight": 0.5, "evidence_rule": "solve_length"}]}, "tags": ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_POWER_OF_POINT", "role": "primary", "evidence_rule": "rubric.power_theorem"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.solve_length"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_006', 'K_POWER_OF_POINT', 'primary', 'rubric.power_theorem'),
  ('tnt_dev00001', 'Q_THE_006', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.solve_length'),
  ('tnt_dev00001', 'Q_THE_006', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_006', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_006', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_006', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_007', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_HIDDEN_CIRCLE","T_POWER_AND_CIRCLE"}', '{"K_HIDDEN_CIRCLE","T_POWER_AND_CIRCLE","K_TRIANGLE_EXISTENCE"}', true, '{"question_id": "Q_THE_007", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "定点 A、B 满足 AB=8，动点 P 满足 ∠APB=90°。求点 P 轨迹圆的面积。", "stem_format": "open_solution", "answer": {"summary": "∠APB=90° → P 在以 AB 为直径的圆上 → 半径 4 → S=16π。"}, "rubric": {"items": [{"id": "cyclic_detect", "description": "直角圆周角定直径", "score_weight": 0.5, "evidence_rule": "cyclic_detect"}, {"id": "compute_area", "description": "求圆面积", "score_weight": 0.5, "evidence_rule": "compute_area"}]}, "tags": ["K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_HIDDEN_CIRCLE", "role": "primary", "evidence_rule": "rubric.cyclic_detect"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.compute_area"}, {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_007', 'K_HIDDEN_CIRCLE', 'primary', 'rubric.cyclic_detect'),
  ('tnt_dev00001', 'Q_THE_007', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.compute_area'),
  ('tnt_dev00001', 'Q_THE_007', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.K_TRIANGLE_EXISTENCE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_007', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_007', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_007', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_008', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_HIDDEN_CIRCLE","K_CIRCUMCIRCLE","T_POWER_AND_CIRCLE"}', '{"K_HIDDEN_CIRCLE","T_POWER_AND_CIRCLE","K_CIRCUMCIRCLE"}', true, '{"question_id": "Q_THE_008", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "定点 A、B 满足 AB=2√3，动点 P 满足 ∠APB=60°。求 P 所在圆弧所在圆的半径。", "stem_format": "open_solution", "answer": {"summary": "P 在以 AB 为弦、圆周角 60° 的圆弧上 → 2R·sin60°=AB → R=2√3/√3=2。"}, "rubric": {"items": [{"id": "cyclic_detect", "description": "定角圆周角定圆弧", "score_weight": 0.5, "evidence_rule": "cyclic_detect"}, {"id": "compute_radius", "description": "由正弦求半径", "score_weight": 0.5, "evidence_rule": "compute_radius"}]}, "tags": ["K_HIDDEN_CIRCLE", "K_CIRCUMCIRCLE", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_HIDDEN_CIRCLE", "role": "primary", "evidence_rule": "rubric.cyclic_detect"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.compute_radius"}, {"dim": "K_CIRCUMCIRCLE", "role": "prerequisite", "evidence_rule": "probe.K_CIRCUMCIRCLE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_008', 'K_HIDDEN_CIRCLE', 'primary', 'rubric.cyclic_detect'),
  ('tnt_dev00001', 'Q_THE_008', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.compute_radius'),
  ('tnt_dev00001', 'Q_THE_008', 'K_CIRCUMCIRCLE', 'prerequisite', 'probe.K_CIRCUMCIRCLE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_008', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_008', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_008', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_009', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_APOLLONIUS","T_POWER_AND_CIRCLE"}', '{"K_APOLLONIUS","T_POWER_AND_CIRCLE","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_009", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "定点 A(0,0)、B(6,0)，动点 P 满足 PA:PB=2:1。求 P 轨迹圆的半径。", "stem_format": "open_solution", "answer": {"summary": "(x²+y²)=4((x−6)²+y²) → x²+y²−16x+48=0 → (x−8)²+y²=16 → 半径 4。"}, "rubric": {"items": [{"id": "apollonius_setup", "description": "按比例平方列方程", "score_weight": 0.5, "evidence_rule": "apollonius_setup"}, {"id": "complete_square", "description": "配方求半径", "score_weight": 0.5, "evidence_rule": "complete_square"}]}, "tags": ["K_APOLLONIUS", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_APOLLONIUS", "role": "primary", "evidence_rule": "rubric.apollonius_setup"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.complete_square"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_009', 'K_APOLLONIUS', 'primary', 'rubric.apollonius_setup'),
  ('tnt_dev00001', 'Q_THE_009', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.complete_square'),
  ('tnt_dev00001', 'Q_THE_009', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_009', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_009', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_009', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_010', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_POWER_OF_POINT","K_INCIRCLE","T_POWER_AND_CIRCLE"}', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE","K_INCIRCLE"}', true, '{"question_id": "Q_THE_010", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "三角形三边为 13，14，15，其内切圆与 AB（c=15 对边）切于点 D。求从顶点 A 到切点 D 的切线长。", "stem_format": "open_solution", "answer": {"summary": "切线长 = s−a = 21−13 = 8。"}, "rubric": {"items": [{"id": "tangent_length", "description": "切线长等于半周长减对边", "score_weight": 0.5, "evidence_rule": "tangent_length"}, {"id": "solve_length", "description": "代入计算", "score_weight": 0.5, "evidence_rule": "solve_length"}]}, "tags": ["K_POWER_OF_POINT", "K_INCIRCLE", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_POWER_OF_POINT", "role": "primary", "evidence_rule": "rubric.tangent_length"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.solve_length"}, {"dim": "K_INCIRCLE", "role": "prerequisite", "evidence_rule": "probe.K_INCIRCLE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_010', 'K_POWER_OF_POINT', 'primary', 'rubric.tangent_length'),
  ('tnt_dev00001', 'Q_THE_010', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.solve_length'),
  ('tnt_dev00001', 'Q_THE_010', 'K_INCIRCLE', 'prerequisite', 'probe.K_INCIRCLE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_010', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_010', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_010', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_011', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_PTOLEMY","K_POWER_OF_POINT","T_PTOLEMY"}', '{"K_PTOLEMY","T_PTOLEMY","K_POWER_OF_POINT"}', true, '{"question_id": "Q_THE_011", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "圆内接四边形 ABCD 中，AB=3，BC=4，CD=5，DA=6。求 AC·BD。", "stem_format": "open_solution", "answer": {"summary": "托勒密：AC·BD = AB·CD + BC·DA = 15+24 = 39。"}, "rubric": {"items": [{"id": "ptolemy_apply", "description": "写出托勒密定理", "score_weight": 0.5, "evidence_rule": "ptolemy_apply"}, {"id": "compute_product", "description": "代入求对角线乘积", "score_weight": 0.5, "evidence_rule": "compute_product"}]}, "tags": ["K_PTOLEMY", "K_POWER_OF_POINT", "T_PTOLEMY"], "measurement_targets": [{"dim": "K_PTOLEMY", "role": "primary", "evidence_rule": "rubric.ptolemy_apply"}, {"dim": "T_PTOLEMY", "role": "secondary", "evidence_rule": "rubric.compute_product"}, {"dim": "K_POWER_OF_POINT", "role": "prerequisite", "evidence_rule": "probe.K_POWER_OF_POINT"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_011', 'K_PTOLEMY', 'primary', 'rubric.ptolemy_apply'),
  ('tnt_dev00001', 'Q_THE_011', 'T_PTOLEMY', 'secondary', 'rubric.compute_product'),
  ('tnt_dev00001', 'Q_THE_011', 'K_POWER_OF_POINT', 'prerequisite', 'probe.K_POWER_OF_POINT')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_011', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_011', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_011', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_012', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_PTOLEMY","K_COSINE_RULE","T_PTOLEMY"}', '{"K_PTOLEMY","T_PTOLEMY","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_012", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "圆内接矩形长 4、宽 3。求两条对角线长度的乘积。", "stem_format": "open_solution", "answer": {"summary": "对角线均为 5 → 乘积 25（托勒密：AC·BD=AB·CD+BC·DA=3·3+4·4=25 ✓）。"}, "rubric": {"items": [{"id": "ptolemy_apply", "description": "用托勒密定理", "score_weight": 0.5, "evidence_rule": "ptolemy_apply"}, {"id": "compute_product", "description": "求对角线乘积", "score_weight": 0.5, "evidence_rule": "compute_product"}]}, "tags": ["K_PTOLEMY", "K_COSINE_RULE", "T_PTOLEMY"], "measurement_targets": [{"dim": "K_PTOLEMY", "role": "primary", "evidence_rule": "rubric.ptolemy_apply"}, {"dim": "T_PTOLEMY", "role": "secondary", "evidence_rule": "rubric.compute_product"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_012', 'K_PTOLEMY', 'primary', 'rubric.ptolemy_apply'),
  ('tnt_dev00001', 'Q_THE_012', 'T_PTOLEMY', 'secondary', 'rubric.compute_product'),
  ('tnt_dev00001', 'Q_THE_012', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_013', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY"}', '{"K_TANGENT_IDENTITY","T_TANGENT_IDENTITY","K_SINE_RULE"}', true, '{"question_id": "Q_THE_013", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，tanA=1，tanB=3。求 tanC。", "stem_format": "open_solution", "answer": {"summary": "tanC = −(1+3)/(1−3) = 2。"}, "rubric": {"items": [{"id": "tangent_identity", "description": "正切和角公式", "score_weight": 0.5, "evidence_rule": "tangent_identity"}, {"id": "solve_angle", "description": "求 tanC", "score_weight": 0.5, "evidence_rule": "solve_angle"}]}, "tags": ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"], "measurement_targets": [{"dim": "K_TANGENT_IDENTITY", "role": "primary", "evidence_rule": "rubric.tangent_identity"}, {"dim": "T_TANGENT_IDENTITY", "role": "secondary", "evidence_rule": "rubric.solve_angle"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_013', 'K_TANGENT_IDENTITY', 'primary', 'rubric.tangent_identity'),
  ('tnt_dev00001', 'Q_THE_013', 'T_TANGENT_IDENTITY', 'secondary', 'rubric.solve_angle'),
  ('tnt_dev00001', 'Q_THE_013', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_013', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_013', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_013', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_014', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_SINE_SQUARE_DIFF","K_SINE_RULE","T_SHAPE_JUDGE"}', '{"K_SINE_SQUARE_DIFF","T_SHAPE_JUDGE","K_SINE_RULE"}', true, '{"question_id": "Q_THE_014", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "在△ABC中，sin²A=sin²B+sin²C。判断三角形形状。", "stem_format": "open_solution", "answer": {"summary": "边化角：a²=b²+c² → A=90°，直角三角形。"}, "rubric": {"items": [{"id": "sine_to_side", "description": "正弦比化为边比", "score_weight": 0.5, "evidence_rule": "sine_to_side"}, {"id": "conclude_shape", "description": "勾股逆定理判断", "score_weight": 0.5, "evidence_rule": "conclude_shape"}]}, "tags": ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_SHAPE_JUDGE"], "measurement_targets": [{"dim": "K_SINE_SQUARE_DIFF", "role": "primary", "evidence_rule": "rubric.sine_to_side"}, {"dim": "T_SHAPE_JUDGE", "role": "secondary", "evidence_rule": "rubric.conclude_shape"}, {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_014', 'K_SINE_SQUARE_DIFF', 'primary', 'rubric.sine_to_side'),
  ('tnt_dev00001', 'Q_THE_014', 'T_SHAPE_JUDGE', 'secondary', 'rubric.conclude_shape'),
  ('tnt_dev00001', 'Q_THE_014', 'K_SINE_RULE', 'prerequisite', 'probe.K_SINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_014', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_014', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_014', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_015', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE"}', '{"K_POWER_OF_POINT","T_POWER_AND_CIRCLE","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_015", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "从圆外一点 A 作切线 AT 切圆于 T，AT=4；过 A 的割线交圆于 B、C（B 在 A、C 之间），AB=2。求 AC。", "stem_format": "open_solution", "answer": {"summary": "切割线定理：AT²=AB·AC → 16=2·AC → AC=8。"}, "rubric": {"items": [{"id": "power_theorem", "description": "切割线定理", "score_weight": 0.5, "evidence_rule": "power_theorem"}, {"id": "solve_length", "description": "求 AC", "score_weight": 0.5, "evidence_rule": "solve_length"}]}, "tags": ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"], "measurement_targets": [{"dim": "K_POWER_OF_POINT", "role": "primary", "evidence_rule": "rubric.power_theorem"}, {"dim": "T_POWER_AND_CIRCLE", "role": "secondary", "evidence_rule": "rubric.solve_length"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_015', 'K_POWER_OF_POINT', 'primary', 'rubric.power_theorem'),
  ('tnt_dev00001', 'Q_THE_015', 'T_POWER_AND_CIRCLE', 'secondary', 'rubric.solve_length'),
  ('tnt_dev00001', 'Q_THE_015', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_015', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_015', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_015', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);
insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_THE_016', 'tnt_dev00001', 'chap_05', 1, 'open_solution', '{"K_PTOLEMY","K_COSINE_RULE","T_PTOLEMY"}', '{"K_PTOLEMY","T_PTOLEMY","K_COSINE_RULE"}', true, '{"question_id": "Q_THE_016", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "question_version": 1, "stem_markdown": "等腰梯形 ABCD 中，AB∥CD，AB=2，CD=6，腰 AD=BC=4，且四点共圆。求对角线 AC。", "stem_format": "open_solution", "answer": {"summary": "托勒密：AC·BD=AB·CD+BC·AD=12+16=28；等腰梯形对角线相等 → AC=2√7。"}, "rubric": {"items": [{"id": "ptolemy_apply", "description": "托勒密定理求对角线乘积", "score_weight": 0.5, "evidence_rule": "ptolemy_apply"}, {"id": "solve_length", "description": "由对角线相等求 AC", "score_weight": 0.5, "evidence_rule": "solve_length"}]}, "tags": ["K_PTOLEMY", "K_COSINE_RULE", "T_PTOLEMY"], "measurement_targets": [{"dim": "K_PTOLEMY", "role": "primary", "evidence_rule": "rubric.ptolemy_apply"}, {"dim": "T_PTOLEMY", "role": "secondary", "evidence_rule": "rubric.solve_length"}, {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]}'::jsonb)
on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;
insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_THE_016', 'K_PTOLEMY', 'primary', 'rubric.ptolemy_apply'),
  ('tnt_dev00001', 'Q_THE_016', 'T_PTOLEMY', 'secondary', 'rubric.solve_length'),
  ('tnt_dev00001', 'Q_THE_016', 'K_COSINE_RULE', 'prerequisite', 'probe.K_COSINE_RULE')
on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;
insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_THE_016', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_016', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_THE_016', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);

-- ── 已发布章节包（chapter_id 绑定 + 章节作用域 contents，P0-5） ──
insert into content_chapter_package (package_id, tenant_id, chapter_id, version, manifest_hash, published_by, published_at, payload)
values
  ('pkg_chap_01_001', 'tnt_dev00001', 'chap_01', '1.0.0', 'sha256:b7aecf43afd648f30d52d113bc0089efecf85a1e7c99d2a28521733b32d44a10', 'usr_teacher01', now(), '{"package_id": "pkg_chap_01_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_01", "version": "1.0.0", "manifest_hash": "sha256:b7aecf43afd648f30d52d113bc0089efecf85a1e7c99d2a28521733b32d44a10", "contents": {"knowledge_components": ["K_COSINE_RULE", "K_SHAPE_JUDGE", "K_SINE_RULE", "K_SSA", "K_TRIANGLE_AREA", "K_TRIANGLE_EXISTENCE"], "question_types": ["T_ANGLE_SOLVE", "T_AREA_COMPUTE", "T_SHAPE_JUDGE", "T_SIDE_SOLVE", "T_SSA_BRANCH", "T_SSA_SOLVE"], "error_causes": ["E_ANGLE_SIDE_CONVERT", "E_AREA_HALF_MISS", "E_COMPUTE_SLIP", "E_COSINE_SIGN", "E_FORMULA_MISUSE", "E_SHAPE_OVERGENERAL", "E_SINE_AMBIGUITY", "E_SSA_MISSING_OBTUSE"], "questions": ["Q_BAS_001", "Q_BAS_002", "Q_BAS_003", "Q_BAS_004", "Q_BAS_005", "Q_BAS_006", "Q_BAS_007", "Q_BAS_008", "Q_BAS_009", "Q_BAS_010", "Q_BAS_011", "Q_BAS_012", "Q_BAS_013", "Q_BAS_014", "Q_BAS_015", "Q_BAS_016"], "diagnosis_rules": ["R_SSA_BRANCH_CHECK", "R_SINE_AMBIGUITY_CHECK", "R_COSINE_SIGN_CHECK", "R_FORMULA_MISUSE_CHECK", "R_AREA_HALF_CHECK", "R_SHAPE_JUDGE_CHECK", "R_ANGLE_SIDE_CONVERT_CHECK", "R_COMPUTE_SLIP_CHECK"]}, "published_by": "usr_teacher01", "published_at": "2026-08-18T00:00:00Z", "note": "专题章节已发布包"}'),
  ('pkg_chap_02_001', 'tnt_dev00001', 'chap_02', '1.0.0', 'sha256:9be7b1ddd839250a2fd0a6bdca10166813587cac5155476c4629d3cbb184e40c', 'usr_teacher01', now(), '{"package_id": "pkg_chap_02_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_02", "version": "1.0.0", "manifest_hash": "sha256:9be7b1ddd839250a2fd0a6bdca10166813587cac5155476c4629d3cbb184e40c", "contents": {"knowledge_components": ["K_ALTITUDE", "K_ANGLE_BISECTOR", "K_COSINE_RULE", "K_EQUAL_AREA", "K_MEDIAN", "K_SINE_RULE", "K_TRIANGLE_AREA", "K_ZHANG_ANGLE"], "question_types": ["T_ALTITUDE_SOLVE", "T_BISECTOR_SOLVE", "T_EQUAL_AREA", "T_MEDIAN_SOLVE"], "error_causes": ["E_ALTITUDE_BASE_ERR", "E_AREA_HALF_MISS", "E_BISECTOR_RATIO_ERR", "E_COMPUTE_SLIP", "E_COSINE_SIGN", "E_EQUAL_AREA_SETUP_ERR", "E_FORMULA_MISUSE", "E_MEDIAN_FORMULA_ERR"], "questions": ["Q_SEG_001", "Q_SEG_002", "Q_SEG_003", "Q_SEG_004", "Q_SEG_005", "Q_SEG_006", "Q_SEG_007", "Q_SEG_008", "Q_SEG_009", "Q_SEG_010", "Q_SEG_011", "Q_SEG_012", "Q_SEG_013", "Q_SEG_014", "Q_SEG_015", "Q_SEG_016"], "diagnosis_rules": ["R_COSINE_SIGN_CHECK", "R_FORMULA_MISUSE_CHECK", "R_AREA_HALF_CHECK", "R_MEDIAN_FORMULA_CHECK", "R_BISECTOR_RATIO_CHECK", "R_ALTITUDE_BASE_CHECK", "R_EQUAL_AREA_CHECK", "R_COMPUTE_SLIP_CHECK"]}, "published_by": "usr_teacher01", "published_at": "2026-08-18T00:00:00Z", "note": "专题章节已发布包"}'),
  ('pkg_chap_03_001', 'tnt_dev00001', 'chap_03', '1.0.0', 'sha256:85e9b961e7717072c30d1525410ad340619a474b3e520c6f8299d9ddc3cb693e', 'usr_teacher01', now(), '{"package_id": "pkg_chap_03_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_03", "version": "1.0.0", "manifest_hash": "sha256:85e9b961e7717072c30d1525410ad340619a474b3e520c6f8299d9ddc3cb693e", "contents": {"knowledge_components": ["K_CIRCUMCIRCLE", "K_COMMON_EDGE", "K_COSINE_RULE", "K_EQUAL_AREA", "K_HIDDEN_CIRCLE", "K_INCIRCLE", "K_MULTI_TRIANGLE", "K_RADIUS_RELATION", "K_SINE_RULE", "K_TRIANGLE_AREA", "K_TRIANGLE_EXISTENCE"], "question_types": ["T_CIRCUMCIRCLE_SOLVE", "T_COMMON_EDGE", "T_INCIRCLE_SOLVE", "T_MULTI_TRIANGLE", "T_POWER_AND_CIRCLE"], "error_causes": ["E_AREA_HALF_MISS", "E_CIRCUMRADIUS_ERR", "E_COMPUTE_SLIP", "E_COSINE_SIGN", "E_EQUAL_AREA_SETUP_ERR", "E_FORMULA_MISUSE", "E_HIDDEN_CIRCLE_MISS", "E_INRADIUS_AREA_ERR", "E_MULTI_TRI_ANGLE_ERR", "E_SINE_AMBIGUITY", "E_SSA_MISSING_OBTUSE"], "questions": ["Q_CIR_001", "Q_CIR_002", "Q_CIR_003", "Q_CIR_004", "Q_CIR_005", "Q_CIR_006", "Q_CIR_007", "Q_CIR_008", "Q_CIR_009", "Q_CIR_010", "Q_CIR_011", "Q_CIR_012", "Q_CIR_013", "Q_CIR_014", "Q_CIR_015", "Q_CIR_016"], "diagnosis_rules": ["R_SSA_BRANCH_CHECK", "R_SINE_AMBIGUITY_CHECK", "R_COSINE_SIGN_CHECK", "R_FORMULA_MISUSE_CHECK", "R_AREA_HALF_CHECK", "R_EQUAL_AREA_CHECK", "R_CIRCUMRADIUS_CHECK", "R_INRADIUS_CHECK", "R_MULTI_TRIANGLE_CHECK", "R_HIDDEN_CIRCLE_CHECK", "R_COMPUTE_SLIP_CHECK"]}, "published_by": "usr_teacher01", "published_at": "2026-08-18T00:00:00Z", "note": "专题章节已发布包"}'),
  ('pkg_chap_04_001', 'tnt_dev00001', 'chap_04', '1.0.0', 'sha256:792dc75e5fe62731e482611ee92082d4a49686ecec1baae5f9380c028e07fd5c', 'usr_teacher01', now(), '{"package_id": "pkg_chap_04_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_04", "version": "1.0.0", "manifest_hash": "sha256:792dc75e5fe62731e482611ee92082d4a49686ecec1baae5f9380c028e07fd5c", "contents": {"knowledge_components": ["K_ANGLE_TO_SIDE", "K_COSINE_RULE", "K_EDGE_RANGE", "K_INEQUALITY", "K_SIDE_TO_ANGLE", "K_SINE_RULE", "K_TRIANGLE_AREA", "K_TRIANGLE_EXISTENCE", "K_TRIG_RANGE"], "question_types": ["T_ANGLE_SOLVE", "T_INEQUALITY_APPLY", "T_MAX_MIN", "T_SHAPE_JUDGE", "T_TRIG_FUNC_RANGE"], "error_causes": ["E_ANGLE_SIDE_CONVERT", "E_AREA_HALF_MISS", "E_COMPUTE_SLIP", "E_COSINE_SIGN", "E_FORMULA_MISUSE", "E_INEQUALITY_DIRECTION", "E_RANGE_END_MISS", "E_SHAPE_OVERGENERAL", "E_SINE_AMBIGUITY", "E_SSA_MISSING_OBTUSE", "E_TRIG_RANGE_UNBOUNDED"], "questions": ["Q_EXT_001", "Q_EXT_002", "Q_EXT_003", "Q_EXT_004", "Q_EXT_005", "Q_EXT_006", "Q_EXT_007", "Q_EXT_008", "Q_EXT_009", "Q_EXT_010", "Q_EXT_011", "Q_EXT_012", "Q_EXT_013", "Q_EXT_014", "Q_EXT_015", "Q_EXT_016"], "diagnosis_rules": ["R_SSA_BRANCH_CHECK", "R_SINE_AMBIGUITY_CHECK", "R_COSINE_SIGN_CHECK", "R_FORMULA_MISUSE_CHECK", "R_AREA_HALF_CHECK", "R_SHAPE_JUDGE_CHECK", "R_RANGE_END_CHECK", "R_INEQUALITY_DIR_CHECK", "R_TRIG_RANGE_CHECK", "R_ANGLE_SIDE_CONVERT_CHECK", "R_COMPUTE_SLIP_CHECK"]}, "published_by": "usr_teacher01", "published_at": "2026-08-18T00:00:00Z", "note": "专题章节已发布包"}'),
  ('pkg_chap_05_001', 'tnt_dev00001', 'chap_05', '1.0.0', 'sha256:b343dc331e6652d94a9c9d376a9a6e54d4fb853ee50e7b83de999ea34bba3e2b', 'usr_teacher01', now(), '{"package_id": "pkg_chap_05_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_05", "version": "1.0.0", "manifest_hash": "sha256:b343dc331e6652d94a9c9d376a9a6e54d4fb853ee50e7b83de999ea34bba3e2b", "contents": {"knowledge_components": ["K_APOLLONIUS", "K_CIRCUMCIRCLE", "K_COSINE_RULE", "K_HIDDEN_CIRCLE", "K_INCIRCLE", "K_POWER_OF_POINT", "K_PTOLEMY", "K_SINE_RULE", "K_SINE_SQUARE_DIFF", "K_TANGENT_IDENTITY", "K_TRIANGLE_EXISTENCE"], "question_types": ["T_ANGLE_SOLVE", "T_POWER_AND_CIRCLE", "T_PTOLEMY", "T_SHAPE_JUDGE", "T_TANGENT_IDENTITY"], "error_causes": ["E_ANGLE_SIDE_CONVERT", "E_CIRCUMRADIUS_ERR", "E_COMPUTE_SLIP", "E_COSINE_SIGN", "E_FORMULA_MISUSE", "E_HIDDEN_CIRCLE_MISS", "E_INRADIUS_AREA_ERR", "E_SHAPE_OVERGENERAL", "E_SINE_AMBIGUITY", "E_SSA_MISSING_OBTUSE", "E_TANGENT_DENOM_ZERO"], "questions": ["Q_THE_001", "Q_THE_002", "Q_THE_003", "Q_THE_004", "Q_THE_005", "Q_THE_006", "Q_THE_007", "Q_THE_008", "Q_THE_009", "Q_THE_010", "Q_THE_011", "Q_THE_012", "Q_THE_013", "Q_THE_014", "Q_THE_015", "Q_THE_016"], "diagnosis_rules": ["R_SSA_BRANCH_CHECK", "R_SINE_AMBIGUITY_CHECK", "R_COSINE_SIGN_CHECK", "R_FORMULA_MISUSE_CHECK", "R_SHAPE_JUDGE_CHECK", "R_CIRCUMRADIUS_CHECK", "R_INRADIUS_CHECK", "R_ANGLE_SIDE_CONVERT_CHECK", "R_TANGENT_DENOM_CHECK", "R_HIDDEN_CIRCLE_CHECK", "R_COMPUTE_SLIP_CHECK"]}, "published_by": "usr_teacher01", "published_at": "2026-08-18T00:00:00Z", "note": "专题章节已发布包"}')
on conflict (package_id) do nothing;

-- 试点章节包（Q_TRI_012/Q_TRI_020 演示基线）
insert into content_chapter_package (package_id, tenant_id, chapter_id, version, manifest_hash, published_by, published_at, payload)
values ('pkg_tri_pilot_001', 'tnt_dev00001', 'chap_tri_pilot', '0.1.0', 'sha256:pilot-chapter-package-v0.1.0', 'usr_teacher01', now(),
  '{"package_id": "pkg_tri_pilot_001", "tenant_id": "tnt_dev00001", "chapter_id": "chap_tri_pilot", "version": "0.1.0", "manifest_hash": "sha256:pilot-chapter-package-v0.1.0", "contents": {"knowledge_components": ["K_SINE_RULE", "K_SSA", "K_TRIANGLE_EXISTENCE"], "question_types": ["T_SSA_SOLVE"], "error_causes": ["E_SSA_MISSING_OBTUSE"], "questions": ["Q_TRI_012", "Q_TRI_020"], "diagnosis_rules": ["R_SSA_BRANCH_CHECK"]}, "published_by": "usr_teacher01", "note": "dev 试点已发布包"}')
on conflict (package_id) do nothing;

-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student01 高二·95→115 ═══════════
insert into state_student_profile (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)
values ('usr_student01', 'tnt_dev00001', '高二', 95, 115, '7-10', '{"K_SSA"}', '触屏手写', '{"grade": "高二", "current_score": 95, "target_score": 115, "weekly_hours": "7-10", "self_weak": ["K_SSA"], "device_draft": "触屏手写", "student_id": "usr_student01", "tenant_id": "tnt_dev00001", "updated_at": "2026-08-18T00:00:00Z"}')
on conflict (student_id) do update set grade = excluded.grade, current_score = excluded.current_score, target_score = excluded.target_score, weekly_hours = excluded.weekly_hours, self_weak = excluded.self_weak, device_draft = excluded.device_draft, payload = excluded.payload, updated_at = now();
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_01a', 'tnt_dev00001', 'usr_student01', null, 'Q_TRI_012', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 2, null, '{"session_id": "s_demo_01a", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "question_id": "Q_TRI_012", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_01a_1', 'tnt_dev00001', 's_demo_01a', 'usr_student01', '{"answer_text": "由正弦定理 sinB = b·sinA/a = 1/√3，故 B ≈ 35.3°。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_01a_1', 'tnt_dev00001', 's_demo_01a', 'att_demo_01a_1', 'partially_correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_01a_1", "session_id": "s_demo_01a", "attempt_id": "att_demo_01a_1", "verdict": "partially_correct", "rubric_items": [{"id": "setup_sine_rule", "status": "met", "evidence_refs": ["answer://s_demo_01a/att_demo_01a_1"]}, {"id": "ssa_branch_check", "status": "not_met", "evidence_refs": ["answer://s_demo_01a/att_demo_01a_1"]}], "decision_summary": "正弦定理列出正确；仅给出锐角解，遗漏 144.7° 补角分支。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
values ('clm_demo_01a', 'tnt_dev00001', 's_demo_01a', 'resolved', '{"claim_id": "clm_demo_01a", "session_id": "s_demo_01a", "status": "resolved", "candidates": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "confidence": 0.85, "evidence": "只给锐角解"}], "probe": {"question": "sinB=1/√3 时 B 的可能值有哪些？", "judge_rubric": "能列出 35.3° 与 144.7° 两解且验证均满足 A+B<180°"}, "card": {"artifact_id": "art_clm_demo_01a", "card_id": "card_demo_01a"}, "resolved": true, "rationale": "典型 SSA 补角遗漏", "probe_history": [], "created_at": "2026-08-18T00:00:00Z"}') on conflict (claim_id) do nothing;
insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
values ('art_clm_demo_01a', 'tnt_dev00001', 's_demo_01a', 'question_card', 'native_card', 'artifact://s_demo_01a/art_clm_demo_01a') on conflict (artifact_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_01a_2', 'tnt_dev00001', 's_demo_01a', 'usr_student01', '{"answer_text": "sinB=1/√3 时 B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°。", "kind": "probe", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_01a_2', 'tnt_dev00001', 's_demo_01a', 'att_demo_01a_2', 'correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_01a_2", "session_id": "s_demo_01a", "attempt_id": "att_demo_01a_2", "verdict": "correct", "rubric_items": [{"id": "probe.judge", "status": "met", "evidence_refs": ["probe://s_demo_01a/att_demo_01a_2"]}], "decision_summary": "补角分支完整，两解均合法。", "uncertainty": "low", "injection_flags": [], "kind": "probe", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_01a_1', 'tnt_dev00001', 'usr_student01', 'K_SINE_RULE', 'Q_TRI_012', 's_demo_01a', 'jud_demo_01a_1', 'success', true, 'rubric.setup_sine_rule', 0, '{"observation_id": "obs_s_demo_01a_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "dimension_id": "K_SINE_RULE", "question_id": "Q_TRI_012", "session_id": "s_demo_01a", "outcome": "success", "independent": true, "evidence_rule": "rubric.setup_sine_rule", "hint_level": 0, "evidence_refs": ["answer://s_demo_01a/att_demo_01a_1"], "model_version": "pi.scnet", "rule_version": "rubric.setup_sine_rule", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_01a_2', 'tnt_dev00001', 'usr_student01', 'K_SSA', 'Q_TRI_012', 's_demo_01a', 'jud_demo_01a_1', 'failure', true, 'rubric.ssa_branch_check', 0, '{"observation_id": "obs_s_demo_01a_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "dimension_id": "K_SSA", "question_id": "Q_TRI_012", "session_id": "s_demo_01a", "outcome": "failure", "independent": true, "evidence_rule": "rubric.ssa_branch_check", "hint_level": 0, "evidence_refs": ["answer://s_demo_01a/att_demo_01a_1"], "model_version": "pi.scnet", "rule_version": "rubric.ssa_branch_check", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_01a_3', 'tnt_dev00001', 'usr_student01', 'K_SSA', 'Q_TRI_012', 's_demo_01a', 'jud_demo_01a_2', 'success', false, 'probe.judge', 0, '{"observation_id": "obs_s_demo_01a_3", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "dimension_id": "K_SSA", "question_id": "Q_TRI_012", "session_id": "s_demo_01a", "outcome": "success", "independent": false, "evidence_rule": "probe.judge", "hint_level": 0, "evidence_refs": ["probe://s_demo_01a/att_demo_01a_2"], "model_version": "pi.scnet", "rule_version": "probe.judge", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_01a', 'tnt_dev00001', 's_demo_01a', 'usr_student01', 'K_SSA', 0.051, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_01a", "session_id": "s_demo_01a", "student_id": "usr_student01", "dimension_id": "K_SSA", "p_bkt_baseline": 0.051, "independent_observation_count": 1, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_01a_1", "obs_s_demo_01a_2", "obs_s_demo_01a_3"], "calculation_trace_ref": "calc_s_demo_01a", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_01a', 'tnt_dev00001', 's_demo_01a', 'ser_demo_01a', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_01a", "session_id": "s_demo_01a", "scientific_evaluation_ref": "ser_demo_01a", "summary": "学生能独立列出正弦定理并解出 sinB=1/√3，但第一次遗漏 SSA 补角分支；补角判断题卡作答正确后自行修正。", "method_observations": [], "misconception_candidates": [{"claim_id": "clm_demo_01a", "status": "resolved"}], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_01a/att_demo_01a_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_01a', 'tnt_dev00001', 's_demo_01a', 'usr_student01', 'ser_demo_01a', 'tss_demo_01a', true, now(), '{"record_id": "slr_demo_01a", "session_id": "s_demo_01a", "student_id": "usr_student01", "scientific_evaluation_report_id": "ser_demo_01a", "teaching_session_summary_id": "tss_demo_01a", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_01b', 'tnt_dev00001', 'usr_student01', null, 'Q_TRI_020', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 1, null, '{"session_id": "s_demo_01b", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "question_id": "Q_TRI_020", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_01b_1', 'tnt_dev00001', 's_demo_01b', 'usr_student01', '{"answer_text": "sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_01b_1', 'tnt_dev00001', 's_demo_01b', 'att_demo_01b_1', 'correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_01b_1", "session_id": "s_demo_01b", "attempt_id": "att_demo_01b_1", "verdict": "correct", "rubric_items": [{"id": "setup_sine_rule", "status": "met", "evidence_refs": ["answer://s_demo_01b/att_demo_01b_1"]}, {"id": "ssa_branch_check", "status": "met", "evidence_refs": ["answer://s_demo_01b/att_demo_01b_1"]}], "decision_summary": "正弦定理正确，两解讨论完整。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_01b_1', 'tnt_dev00001', 'usr_student01', 'K_SINE_RULE', 'Q_TRI_020', 's_demo_01b', 'jud_demo_01b_1', 'success', true, 'rubric.setup_sine_rule', 0, '{"observation_id": "obs_s_demo_01b_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "dimension_id": "K_SINE_RULE", "question_id": "Q_TRI_020", "session_id": "s_demo_01b", "outcome": "success", "independent": true, "evidence_rule": "rubric.setup_sine_rule", "hint_level": 0, "evidence_refs": ["answer://s_demo_01b/att_demo_01b_1"], "model_version": "pi.scnet", "rule_version": "rubric.setup_sine_rule", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_01b_2', 'tnt_dev00001', 'usr_student01', 'K_SSA', 'Q_TRI_020', 's_demo_01b', 'jud_demo_01b_1', 'success', true, 'rubric.ssa_branch_check', 0, '{"observation_id": "obs_s_demo_01b_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student01", "dimension_id": "K_SSA", "question_id": "Q_TRI_020", "session_id": "s_demo_01b", "outcome": "success", "independent": true, "evidence_rule": "rubric.ssa_branch_check", "hint_level": 0, "evidence_refs": ["answer://s_demo_01b/att_demo_01b_1"], "model_version": "pi.scnet", "rule_version": "rubric.ssa_branch_check", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_01b', 'tnt_dev00001', 's_demo_01b', 'usr_student01', 'K_SSA', 0.194, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_01b", "session_id": "s_demo_01b", "student_id": "usr_student01", "dimension_id": "K_SSA", "p_bkt_baseline": 0.194, "independent_observation_count": 2, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_01b_1", "obs_s_demo_01b_2"], "calculation_trace_ref": "calc_s_demo_01b", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_01b', 'tnt_dev00001', 's_demo_01b', 'ser_demo_01b', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_01b", "session_id": "s_demo_01b", "scientific_evaluation_ref": "ser_demo_01b", "summary": "独立完成 SSA 两解讨论，正确给出 45° 与 135° 并验证存在性；分类讨论习惯已建立。", "method_observations": [], "misconception_candidates": [], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_01b/att_demo_01b_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_01b', 'tnt_dev00001', 's_demo_01b', 'usr_student01', 'ser_demo_01b', 'tss_demo_01b', true, now(), '{"record_id": "slr_demo_01b", "session_id": "s_demo_01b", "student_id": "usr_student01", "scientific_evaluation_report_id": "ser_demo_01b", "teaching_session_summary_id": "tss_demo_01b", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into state_profile_update_decision (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes, review_required, model_id, prompt_version, skill_version, payload)
values ('pud_demo_01', 'tnt_dev00001', 'usr_student01', null, null, null, false, 'demo.model', 'dream-profile@0.5.0', 'profile-skill@0.3.0', '{"decision_id": "pud_demo_01", "student_id": "usr_student01", "prior_snapshot_id": null, "baseline_report_refs": ["ser_demo_01a", "ser_demo_01b"], "teaching_summary_refs": ["tss_demo_01a", "tss_demo_01b"], "dimension_updates": [{"dimension_id": "K_SSA", "p_baseline": 0.194, "p_final": 0.491, "state_final": "learning", "uncertainty": "medium", "evidence_ledger": [{"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0, "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_1"], "explanation": "次题独立完成两解讨论，补角分支方法迁移成功"}, {"code": "SELF_CORRECTION_RECURS", "rubric_bin": "clear", "lr_used": 2.0, "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_2"], "explanation": "追问后自行发现并修正补角遗漏"}]}, {"dimension_id": "K_SINE_RULE", "p_baseline": 0.897, "p_final": 0.958, "state_final": "possibly_mastered", "uncertainty": "low", "evidence_ledger": [{"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0, "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_1"], "explanation": "两题正弦定理列式稳定正确"}, {"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3, "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01b_1"], "explanation": "方法选择稳定"}]}], "semantic_profile_updates": [], "review_required": false, "model_id": "demo.model", "prompt_version": "dream-profile@0.5.0", "skill_version": "profile-skill@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (decision_id) do nothing;
insert into state_profile_decision_validation (validation_id, tenant_id, decision_id, result, validator_version, payload)
values ('pvr_demo_01', 'tnt_dev00001', 'pud_demo_01', 'passed', 'profile-validator-0.2.0', '{"validation_id": "pvr_demo_01", "decision_id": "pud_demo_01", "result": "passed", "validator_version": "profile-validator-0.2.0", "validated_at": "2026-08-18T00:00:00Z"}') on conflict (validation_id) do nothing;
insert into state_student_snapshot (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)
values ('snap_demo_01', 'tnt_dev00001', 'usr_student01', 'pud_demo_01', null, false, '{"snapshot_id": "snap_demo_01", "student_id": "usr_student01", "source_decision_id": "pud_demo_01", "supersedes": null, "dimensions": [{"dimension_id": "K_SSA", "p_profile": 0.491, "p_bkt_baseline": 0.194, "state": "learning", "uncertainty": "medium", "independent_observation_count": 2}, {"dimension_id": "K_SINE_RULE", "p_profile": 0.958, "p_bkt_baseline": 0.897, "state": "possibly_mastered", "uncertainty": "low", "independent_observation_count": 2}], "misconceptions": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "state": "confirmed", "evidence_refs": ["claim://clm_demo_01a"]}], "semantic_profile": {}, "profile_lag": false}') on conflict (snapshot_id) do nothing;
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student01', 'K_SSA', 0.491, 'learning', 'pud_demo_01')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student01', 'K_SINE_RULE', 0.958, 'possibly_mastered', 'pud_demo_01')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)
values ('tnt_dev00001', 'usr_student01', 'E_SSA_MISSING_OBTUSE', 'confirmed', '["claim://clm_demo_01a"]') on conflict (student_id, error_cause_id) do nothing;
insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable, updated_at)
values ('tnt_dev00001', 'usr_student01', 'K_SSA', '{"0.5": 0.125, "1": 0.125, "2": 0.125, "4": 0.125, "8": 0.125, "16": 0.125, "32": 0.125, "64": 0.125}', null, false, now()) on conflict (student_id, dimension_id) do nothing;
insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)
values ('pln_usr_student01', 'tnt_dev00001', 'usr_student01', 4, '{"plan_id": "pln_usr_student01", "student_id": "usr_student01", "tenant_id": "tnt_dev00001", "horizon_weeks": 4, "explanation": "先补 SSA 解的个数讨论（分类讨论专项），再练正弦定理迁移，最后延迟复测验证保持率。", "tasks": [{"week": 1, "kind": "knowledge_review", "dimension_ids": ["K_SSA"], "criterion": "能独立复述该维度核心方法与适用条件", "review_condition": "下周低档练习正确率 ≥0.7", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["K_SSA"], "criterion": "低一档练习正确率 ≥0.7", "review_condition": "达标后进入原难度练习", "minutes": 30}, {"week": 2, "kind": "practice_normal", "dimension_ids": ["K_SSA"], "criterion": "原难度练习正确率 ≥0.7 且无提示", "review_condition": "独立复测到期后验证", "minutes": 30}, {"week": 3, "kind": "practice_normal", "dimension_ids": ["K_SSA"], "criterion": "原难度综合题正确率 ≥0.7", "review_condition": "周 4 迁移题验证", "minutes": 30}, {"week": 4, "kind": "transfer", "dimension_ids": ["K_SSA"], "criterion": "跨表征/题型独立迁移成功", "review_condition": "迁移成功进入画像证据账本", "minutes": 30}], "plan_skipped": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (plan_id) do update set student_id = excluded.student_id, horizon_weeks = excluded.horizon_weeks, payload = excluded.payload;
-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student02 高一·60→90 ═══════════
insert into state_student_profile (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)
values ('usr_student02', 'tnt_dev00001', '高一', 60, 90, '4-6', '{"K_SINE_RULE"}', '无草稿', '{"grade": "高一", "current_score": 60, "target_score": 90, "weekly_hours": "4-6", "self_weak": ["K_SINE_RULE"], "device_draft": "无草稿", "student_id": "usr_student02", "tenant_id": "tnt_dev00001", "updated_at": "2026-08-18T00:00:00Z"}')
on conflict (student_id) do update set grade = excluded.grade, current_score = excluded.current_score, target_score = excluded.target_score, weekly_hours = excluded.weekly_hours, self_weak = excluded.self_weak, device_draft = excluded.device_draft, payload = excluded.payload, updated_at = now();
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_02a', 'tnt_dev00001', 'usr_student02', null, 'Q_BAS_003', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 1, null, '{"session_id": "s_demo_02a", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "question_id": "Q_BAS_003", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_02a_1', 'tnt_dev00001', 's_demo_02a', 'usr_student02', '{"answer_text": "a/sin60° = 2√2/sin45° → a = 2√2·(√3/2)/(√2/2)·(1/2)，算得 a=√3。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_02a_1', 'tnt_dev00001', 's_demo_02a', 'att_demo_02a_1', 'partially_correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_02a_1", "session_id": "s_demo_02a", "attempt_id": "att_demo_02a_1", "verdict": "partially_correct", "rubric_items": [{"id": "setup_sine_rule", "status": "met", "evidence_refs": ["answer://s_demo_02a/att_demo_02a_1"]}, {"id": "solve_side", "status": "not_met", "evidence_refs": ["answer://s_demo_02a/att_demo_02a_1"]}], "decision_summary": "正弦定理列式正确；代入运算出错（sin45° 值或约分错误），结果应为 2√3。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
values ('clm_demo_02a', 'tnt_dev00001', 's_demo_02a', 'skipped', '{"claim_id": "clm_demo_02a", "session_id": "s_demo_02a", "status": "skipped", "candidates": [{"error_cause_id": "E_COMPUTE_SLIP", "confidence": 0.6, "evidence": "代入运算偏差"}, {"error_cause_id": "E_FORMULA_MISUSE", "confidence": 0.4, "evidence": "列式正确但结果偏差"}], "probe": {"question": "sin45° 与 sin60° 的值分别是多少？重算 a 的值。", "judge_rubric": "正确写出特殊角正弦值并算得 a=2√3"}, "card": {"artifact_id": "art_clm_demo_02a", "card_id": "card_demo_02a"}, "resolved": false, "rationale": "运算环节出错", "probe_history": [], "created_at": "2026-08-18T00:00:00Z"}') on conflict (claim_id) do nothing;
insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
values ('art_clm_demo_02a', 'tnt_dev00001', 's_demo_02a', 'question_card', 'native_card', 'artifact://s_demo_02a/art_clm_demo_02a') on conflict (artifact_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_02a_1', 'tnt_dev00001', 'usr_student02', 'K_SINE_RULE', 'Q_BAS_003', 's_demo_02a', 'jud_demo_02a_1', 'success', true, 'rubric.setup_sine_rule', 0, '{"observation_id": "obs_s_demo_02a_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "dimension_id": "K_SINE_RULE", "question_id": "Q_BAS_003", "session_id": "s_demo_02a", "outcome": "success", "independent": true, "evidence_rule": "rubric.setup_sine_rule", "hint_level": 0, "evidence_refs": ["answer://s_demo_02a/att_demo_02a_1"], "model_version": "pi.scnet", "rule_version": "rubric.setup_sine_rule", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_02a_2', 'tnt_dev00001', 'usr_student02', 'T_ANGLE_SOLVE', 'Q_BAS_003', 's_demo_02a', 'jud_demo_02a_1', 'failure', true, 'rubric.solve_side', 0, '{"observation_id": "obs_s_demo_02a_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "dimension_id": "T_ANGLE_SOLVE", "question_id": "Q_BAS_003", "session_id": "s_demo_02a", "outcome": "failure", "independent": true, "evidence_rule": "rubric.solve_side", "hint_level": 0, "evidence_refs": ["answer://s_demo_02a/att_demo_02a_1"], "model_version": "pi.scnet", "rule_version": "rubric.solve_side", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_02a', 'tnt_dev00001', 's_demo_02a', 'usr_student02', 'K_SINE_RULE', 0.659, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_02a", "session_id": "s_demo_02a", "student_id": "usr_student02", "dimension_id": "K_SINE_RULE", "p_bkt_baseline": 0.659, "independent_observation_count": 1, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_02a_1", "obs_s_demo_02a_2"], "calculation_trace_ref": "calc_s_demo_02a", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_02a', 'tnt_dev00001', 's_demo_02a', 'ser_demo_02a', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_02a", "session_id": "s_demo_02a", "scientific_evaluation_ref": "ser_demo_02a", "summary": "正弦定理比例式写出，代入时 sin45° 值用错导致结果偏差；追问卡跳过（学生未作答），证据留待后续会话确认。", "method_observations": [], "misconception_candidates": [{"claim_id": "clm_demo_02a", "status": "skipped"}], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_02a/att_demo_02a_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_02a', 'tnt_dev00001', 's_demo_02a', 'usr_student02', 'ser_demo_02a', 'tss_demo_02a', true, now(), '{"record_id": "slr_demo_02a", "session_id": "s_demo_02a", "student_id": "usr_student02", "scientific_evaluation_report_id": "ser_demo_02a", "teaching_session_summary_id": "tss_demo_02a", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_02b', 'tnt_dev00001', 'usr_student02', null, 'Q_BAS_002', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 1, null, '{"session_id": "s_demo_02b", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "question_id": "Q_BAS_002", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_02b_1', 'tnt_dev00001', 's_demo_02b', 'usr_student02', '{"answer_text": "sinB = b·sinA/a = √2/2，所以 B = 45°。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_02b_1', 'tnt_dev00001', 's_demo_02b', 'att_demo_02b_1', 'incorrect', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_02b_1", "session_id": "s_demo_02b", "attempt_id": "att_demo_02b_1", "verdict": "incorrect", "rubric_items": [{"id": "setup_sine_rule", "status": "met", "evidence_refs": ["answer://s_demo_02b/att_demo_02b_1"]}, {"id": "ssa_branch_check", "status": "not_met", "evidence_refs": ["answer://s_demo_02b/att_demo_02b_1"]}], "decision_summary": "正弦定理正确但漏 135° 分支，分类讨论不完整。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
values ('clm_demo_02b', 'tnt_dev00001', 's_demo_02b', 'unresolved', '{"claim_id": "clm_demo_02b", "session_id": "s_demo_02b", "status": "unresolved", "candidates": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "confidence": 0.9, "evidence": "只给锐角解"}], "probe": {"question": "sinB=√2/2 时 B 的可能值有哪些？", "judge_rubric": "能列出 45° 与 135° 两解"}, "card": {"artifact_id": "art_clm_demo_02b", "card_id": "card_demo_02b"}, "resolved": false, "rationale": "典型 SSA 补角遗漏，追问未闭合", "probe_history": [], "created_at": "2026-08-18T00:00:00Z"}') on conflict (claim_id) do nothing;
insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
values ('art_clm_demo_02b', 'tnt_dev00001', 's_demo_02b', 'question_card', 'native_card', 'artifact://s_demo_02b/art_clm_demo_02b') on conflict (artifact_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_02b_1', 'tnt_dev00001', 'usr_student02', 'T_SSA_BRANCH', 'Q_BAS_002', 's_demo_02b', 'jud_demo_02b_1', 'success', true, 'rubric.setup_sine_rule', 0, '{"observation_id": "obs_s_demo_02b_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "dimension_id": "T_SSA_BRANCH", "question_id": "Q_BAS_002", "session_id": "s_demo_02b", "outcome": "success", "independent": true, "evidence_rule": "rubric.setup_sine_rule", "hint_level": 0, "evidence_refs": ["answer://s_demo_02b/att_demo_02b_1"], "model_version": "pi.scnet", "rule_version": "rubric.setup_sine_rule", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_02b_2', 'tnt_dev00001', 'usr_student02', 'K_SSA', 'Q_BAS_002', 's_demo_02b', 'jud_demo_02b_1', 'failure', true, 'rubric.ssa_branch_check', 0, '{"observation_id": "obs_s_demo_02b_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student02", "dimension_id": "K_SSA", "question_id": "Q_BAS_002", "session_id": "s_demo_02b", "outcome": "failure", "independent": true, "evidence_rule": "rubric.ssa_branch_check", "hint_level": 0, "evidence_refs": ["answer://s_demo_02b/att_demo_02b_1"], "model_version": "pi.scnet", "rule_version": "rubric.ssa_branch_check", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_02b', 'tnt_dev00001', 's_demo_02b', 'usr_student02', 'K_SSA', 0.051, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_02b", "session_id": "s_demo_02b", "student_id": "usr_student02", "dimension_id": "K_SSA", "p_bkt_baseline": 0.051, "independent_observation_count": 1, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_02b_1", "obs_s_demo_02b_2"], "calculation_trace_ref": "calc_s_demo_02b", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_02b', 'tnt_dev00001', 's_demo_02b', 'ser_demo_02b', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_02b", "session_id": "s_demo_02b", "scientific_evaluation_ref": "ser_demo_02b", "summary": "能由正弦定理解出 sinB=√2/2，但只取 45° 一个解，遗漏 135° 补角；追问未答，错因待观察。", "method_observations": [], "misconception_candidates": [{"claim_id": "clm_demo_02b", "status": "unresolved"}], "hint_dependency": "low", "unresolved": [{"claim_id": "clm_demo_02b"}], "evidence_refs": ["answer://s_demo_02b/att_demo_02b_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_02b', 'tnt_dev00001', 's_demo_02b', 'usr_student02', 'ser_demo_02b', 'tss_demo_02b', true, now(), '{"record_id": "slr_demo_02b", "session_id": "s_demo_02b", "student_id": "usr_student02", "scientific_evaluation_report_id": "ser_demo_02b", "teaching_session_summary_id": "tss_demo_02b", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into state_profile_update_decision (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes, review_required, model_id, prompt_version, skill_version, payload)
values ('pud_demo_02', 'tnt_dev00001', 'usr_student02', null, null, null, false, 'demo.model', 'dream-profile@0.5.0', 'profile-skill@0.3.0', '{"decision_id": "pud_demo_02", "student_id": "usr_student02", "prior_snapshot_id": null, "baseline_report_refs": ["ser_demo_02a", "ser_demo_02b"], "teaching_summary_refs": ["tss_demo_02a", "tss_demo_02b"], "dimension_updates": [{"dimension_id": "K_SINE_RULE", "p_baseline": 0.659, "p_final": 0.491, "state_final": "insufficient_evidence", "uncertainty": "high", "evidence_ledger": [{"code": "TRANSFER_FAILURE_DISTINCT_CONTEXT", "rubric_bin": "unclear", "lr_used": 0.5, "session_refs": ["s_demo_02a", "s_demo_02b"], "evidence_refs": ["obs_s_demo_02a_1", "obs_s_demo_02b_1"], "explanation": "两题正弦定理列式正确但运算环节不稳（一次运算失误、一次分类遗漏），证据不足以下调，保守保持基准"}]}, {"dimension_id": "K_SSA", "p_baseline": 0.051, "p_final": 0.026, "state_final": "insufficient_evidence", "uncertainty": "high", "evidence_ledger": [{"code": "TRANSFER_FAILURE_DISTINCT_CONTEXT", "rubric_bin": "unclear", "lr_used": 0.5, "session_refs": ["s_demo_02a", "s_demo_02b"], "evidence_refs": ["obs_s_demo_02b_2"], "explanation": "补角分支遗漏且追问未闭合，维持低掌握估计"}]}], "semantic_profile_updates": [], "review_required": false, "model_id": "demo.model", "prompt_version": "dream-profile@0.5.0", "skill_version": "profile-skill@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (decision_id) do nothing;
insert into state_profile_decision_validation (validation_id, tenant_id, decision_id, result, validator_version, payload)
values ('pvr_demo_02', 'tnt_dev00001', 'pud_demo_02', 'passed', 'profile-validator-0.2.0', '{"validation_id": "pvr_demo_02", "decision_id": "pud_demo_02", "result": "passed", "validator_version": "profile-validator-0.2.0", "validated_at": "2026-08-18T00:00:00Z"}') on conflict (validation_id) do nothing;
insert into state_student_snapshot (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)
values ('snap_demo_02', 'tnt_dev00001', 'usr_student02', 'pud_demo_02', null, false, '{"snapshot_id": "snap_demo_02", "student_id": "usr_student02", "source_decision_id": "pud_demo_02", "supersedes": null, "dimensions": [{"dimension_id": "K_SINE_RULE", "p_profile": 0.491, "p_bkt_baseline": 0.659, "state": "insufficient_evidence", "uncertainty": "high", "independent_observation_count": 1}, {"dimension_id": "K_SSA", "p_profile": 0.026, "p_bkt_baseline": 0.051, "state": "insufficient_evidence", "uncertainty": "high", "independent_observation_count": 1}], "misconceptions": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "state": "suspected", "evidence_refs": ["claim://clm_demo_02b"]}, {"error_cause_id": "E_COMPUTE_SLIP", "state": "suspected", "evidence_refs": ["claim://clm_demo_02a"]}], "semantic_profile": {}, "profile_lag": false}') on conflict (snapshot_id) do nothing;
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student02', 'K_SINE_RULE', 0.491, 'insufficient_evidence', 'pud_demo_02')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student02', 'K_SSA', 0.026, 'insufficient_evidence', 'pud_demo_02')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)
values ('tnt_dev00001', 'usr_student02', 'E_SSA_MISSING_OBTUSE', 'suspected', '["claim://clm_demo_02b"]') on conflict (student_id, error_cause_id) do nothing;
insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)
values ('tnt_dev00001', 'usr_student02', 'E_COMPUTE_SLIP', 'suspected', '["claim://clm_demo_02a"]') on conflict (student_id, error_cause_id) do nothing;
insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable, updated_at)
values ('tnt_dev00001', 'usr_student02', 'K_SINE_RULE', '{"0.5": 0.125, "1": 0.125, "2": 0.125, "4": 0.125, "8": 0.125, "16": 0.125, "32": 0.125, "64": 0.125}', null, false, now()) on conflict (student_id, dimension_id) do nothing;
insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)
values ('pln_usr_student02', 'tnt_dev00001', 'usr_student02', 4, '{"plan_id": "pln_usr_student02", "student_id": "usr_student02", "tenant_id": "tnt_dev00001", "horizon_weeks": 4, "explanation": "基础薄弱：先补正弦定理公式与特殊角值（知识补讲+低一档练习），再专项训练 SSA 分类讨论，最后迁移与延迟复测。", "tasks": [{"week": 1, "kind": "knowledge_review", "dimension_ids": ["K_SINE_RULE"], "criterion": "能独立复述该维度核心方法与适用条件", "review_condition": "下周低档练习正确率 ≥0.7", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["K_SINE_RULE"], "criterion": "低一档练习正确率 ≥0.7", "review_condition": "达标后进入原难度练习", "minutes": 30}, {"week": 2, "kind": "practice_normal", "dimension_ids": ["K_SINE_RULE"], "criterion": "原难度练习正确率 ≥0.7 且无提示", "review_condition": "独立复测到期后验证", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["K_SINE_RULE"], "criterion": "覆盖练习 ≥3 题且正确率 ≥0.7", "review_condition": "后续会话纳入覆盖测评", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["K_SSA"], "criterion": "覆盖练习 ≥3 题且正确率 ≥0.7", "review_condition": "后续会话纳入覆盖测评", "minutes": 30}, {"week": 3, "kind": "practice_normal", "dimension_ids": ["K_SINE_RULE"], "criterion": "原难度综合题正确率 ≥0.7", "review_condition": "周 4 迁移题验证", "minutes": 30}, {"week": 4, "kind": "transfer", "dimension_ids": ["K_SINE_RULE"], "criterion": "跨表征/题型独立迁移成功", "review_condition": "迁移成功进入画像证据账本", "minutes": 30}, {"week": 3, "kind": "practice_normal", "dimension_ids": ["K_SINE_RULE"], "criterion": "原难度综合题正确率 ≥0.7", "review_condition": "周 4 迁移题验证", "minutes": 30}, {"week": 4, "kind": "transfer", "dimension_ids": ["K_SINE_RULE"], "criterion": "跨表征/题型独立迁移成功", "review_condition": "迁移成功进入画像证据账本", "minutes": 30}, {"week": 3, "kind": "practice_normal", "dimension_ids": ["K_SSA"], "criterion": "原难度综合题正确率 ≥0.7", "review_condition": "周 4 迁移题验证", "minutes": 30}, {"week": 4, "kind": "transfer", "dimension_ids": ["K_SSA"], "criterion": "跨表征/题型独立迁移成功", "review_condition": "迁移成功进入画像证据账本", "minutes": 30}], "plan_skipped": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (plan_id) do update set student_id = excluded.student_id, horizon_weeks = excluded.horizon_weeks, payload = excluded.payload;
-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student03 高三·120→135 ═══════════
insert into state_student_profile (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)
values ('usr_student03', 'tnt_dev00001', '高三', 120, 135, '10+', '{}', '纸面拍照', '{"grade": "高三", "current_score": 120, "target_score": 135, "weekly_hours": "10+", "self_weak": [], "device_draft": "纸面拍照", "student_id": "usr_student03", "tenant_id": "tnt_dev00001", "updated_at": "2026-08-18T00:00:00Z"}')
on conflict (student_id) do update set grade = excluded.grade, current_score = excluded.current_score, target_score = excluded.target_score, weekly_hours = excluded.weekly_hours, self_weak = excluded.self_weak, device_draft = excluded.device_draft, payload = excluded.payload, updated_at = now();
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_03a', 'tnt_dev00001', 'usr_student03', null, 'Q_EXT_003', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 1, null, '{"session_id": "s_demo_03a", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "question_id": "Q_EXT_003", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_03a_1', 'tnt_dev00001', 's_demo_03a', 'usr_student03', '{"answer_text": "c²=(a+b)²−3ab ≥ 64−3·16=16，a=b=4 时取等 → c_min=4。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_03a_1', 'tnt_dev00001', 's_demo_03a', 'att_demo_03a_1', 'correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_03a_1", "session_id": "s_demo_03a", "attempt_id": "att_demo_03a_1", "verdict": "correct", "rubric_items": [{"id": "cosine_expand", "status": "met", "evidence_refs": ["answer://s_demo_03a/att_demo_03a_1"]}, {"id": "inequality_apply", "status": "met", "evidence_refs": ["answer://s_demo_03a/att_demo_03a_1"]}], "decision_summary": "余弦定理与基本不等式应用正确，取等条件完整。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03a_1', 'tnt_dev00001', 'usr_student03', 'K_INEQUALITY', 'Q_EXT_003', 's_demo_03a', 'jud_demo_03a_1', 'success', true, 'rubric.cosine_expand', 0, '{"observation_id": "obs_s_demo_03a_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "question_id": "Q_EXT_003", "session_id": "s_demo_03a", "outcome": "success", "independent": true, "evidence_rule": "rubric.cosine_expand", "hint_level": 0, "evidence_refs": ["answer://s_demo_03a/att_demo_03a_1"], "model_version": "pi.scnet", "rule_version": "rubric.cosine_expand", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03a_2', 'tnt_dev00001', 'usr_student03', 'T_INEQUALITY_APPLY', 'Q_EXT_003', 's_demo_03a', 'jud_demo_03a_1', 'success', true, 'rubric.inequality_apply', 0, '{"observation_id": "obs_s_demo_03a_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "T_INEQUALITY_APPLY", "question_id": "Q_EXT_003", "session_id": "s_demo_03a", "outcome": "success", "independent": true, "evidence_rule": "rubric.inequality_apply", "hint_level": 0, "evidence_refs": ["answer://s_demo_03a/att_demo_03a_1"], "model_version": "pi.scnet", "rule_version": "rubric.inequality_apply", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_03a', 'tnt_dev00001', 's_demo_03a', 'usr_student03', 'K_INEQUALITY', 0.659, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_03a", "session_id": "s_demo_03a", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "p_bkt_baseline": 0.659, "independent_observation_count": 1, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_03a_1", "obs_s_demo_03a_2"], "calculation_trace_ref": "calc_s_demo_03a", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_03a', 'tnt_dev00001', 's_demo_03a', 'ser_demo_03a', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_03a", "session_id": "s_demo_03a", "scientific_evaluation_ref": "ser_demo_03a", "summary": "余弦定理展开后直接用基本不等式求下界，取等条件说明完整（a=b=4），一次通过。", "method_observations": [], "misconception_candidates": [], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_03a/att_demo_03a_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_03a', 'tnt_dev00001', 's_demo_03a', 'usr_student03', 'ser_demo_03a', 'tss_demo_03a', true, now(), '{"record_id": "slr_demo_03a", "session_id": "s_demo_03a", "student_id": "usr_student03", "scientific_evaluation_report_id": "ser_demo_03a", "teaching_session_summary_id": "tss_demo_03a", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_03b', 'tnt_dev00001', 'usr_student03', null, 'Q_EXT_009', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 1, null, '{"session_id": "s_demo_03b", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "question_id": "Q_EXT_009", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_03b_1', 'tnt_dev00001', 's_demo_03b', 'usr_student03', '{"answer_text": "c²=a²+b²−ab ≥ (a+b)²/4 → c≥2，a=b=2 时取等 → S_max=√3。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_03b_1', 'tnt_dev00001', 's_demo_03b', 'att_demo_03b_1', 'correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_03b_1", "session_id": "s_demo_03b", "attempt_id": "att_demo_03b_1", "verdict": "correct", "rubric_items": [{"id": "area_expression", "status": "met", "evidence_refs": ["answer://s_demo_03b/att_demo_03b_1"]}, {"id": "inequality_apply", "status": "met", "evidence_refs": ["answer://s_demo_03b/att_demo_03b_1"]}], "decision_summary": "不等式方向与取等验证完整。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03b_1', 'tnt_dev00001', 'usr_student03', 'T_MAX_MIN', 'Q_EXT_009', 's_demo_03b', 'jud_demo_03b_1', 'success', true, 'rubric.area_expression', 0, '{"observation_id": "obs_s_demo_03b_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "T_MAX_MIN", "question_id": "Q_EXT_009", "session_id": "s_demo_03b", "outcome": "success", "independent": true, "evidence_rule": "rubric.area_expression", "hint_level": 0, "evidence_refs": ["answer://s_demo_03b/att_demo_03b_1"], "model_version": "pi.scnet", "rule_version": "rubric.area_expression", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03b_2', 'tnt_dev00001', 'usr_student03', 'K_INEQUALITY', 'Q_EXT_009', 's_demo_03b', 'jud_demo_03b_1', 'success', true, 'rubric.inequality_apply', 0, '{"observation_id": "obs_s_demo_03b_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "question_id": "Q_EXT_009", "session_id": "s_demo_03b", "outcome": "success", "independent": true, "evidence_rule": "rubric.inequality_apply", "hint_level": 0, "evidence_refs": ["answer://s_demo_03b/att_demo_03b_1"], "model_version": "pi.scnet", "rule_version": "rubric.inequality_apply", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_03b', 'tnt_dev00001', 's_demo_03b', 'usr_student03', 'K_INEQUALITY', 0.897, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_03b", "session_id": "s_demo_03b", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "p_bkt_baseline": 0.897, "independent_observation_count": 2, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_03b_1", "obs_s_demo_03b_2"], "calculation_trace_ref": "calc_s_demo_03b", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_03b', 'tnt_dev00001', 's_demo_03b', 'ser_demo_03b', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_03b", "session_id": "s_demo_03b", "scientific_evaluation_ref": "ser_demo_03b", "summary": "周长条件下的面积最值，不等式与取等处理一次通过（a=b=2）。", "method_observations": [], "misconception_candidates": [], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_03b/att_demo_03b_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_03b', 'tnt_dev00001', 's_demo_03b', 'usr_student03', 'ser_demo_03b', 'tss_demo_03b', true, now(), '{"record_id": "slr_demo_03b", "session_id": "s_demo_03b", "student_id": "usr_student03", "scientific_evaluation_report_id": "ser_demo_03b", "teaching_session_summary_id": "tss_demo_03b", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)
values ('s_demo_03c', 'tnt_dev00001', 'usr_student03', null, 'Q_EXT_004', '1.0.0', 'diagnostic', false, 'CLOSED', jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, 2, null, '{"session_id": "s_demo_03c", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "question_id": "Q_EXT_004", "chapter_package_version": "1.0.0", "mode": "diagnostic", "draft_enabled": false, "counts_toward_independent_evidence": true, "state": "CLOSED", "closed_at": "2026-08-18T00:00:00Z"}')
on conflict (session_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_03c_1', 'tnt_dev00001', 's_demo_03c', 'usr_student03', '{"answer_text": "S=√3ab/4，a+b=10 → ab≤25 → S≤25√3/4。", "kind": "answer", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_03c_1', 'tnt_dev00001', 's_demo_03c', 'att_demo_03c_1', 'partially_correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_03c_1", "session_id": "s_demo_03c", "attempt_id": "att_demo_03c_1", "verdict": "partially_correct", "rubric_items": [{"id": "area_expression", "status": "met", "evidence_refs": ["answer://s_demo_03c/att_demo_03c_1"]}, {"id": "inequality_apply", "status": "not_met", "evidence_refs": ["answer://s_demo_03c/att_demo_03c_1"]}], "decision_summary": "ab 上界正确但未说明取等条件 a=b=5 能否同时满足三角形条件。", "uncertainty": "low", "injection_flags": [], "kind": "answer", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
values ('clm_demo_03c', 'tnt_dev00001', 's_demo_03c', 'resolved', '{"claim_id": "clm_demo_03c", "session_id": "s_demo_03c", "status": "resolved", "candidates": [{"error_cause_id": "E_RANGE_END_MISS", "confidence": 0.8, "evidence": "未验证取等可达"}], "probe": {"question": "a=b=5 时 C=60° 的三角形存在吗？验证取等。", "judge_rubric": "验证 a=b=5、C=60° 构成三角形（等边）"}, "card": {"artifact_id": "art_clm_demo_03c", "card_id": "card_demo_03c"}, "resolved": true, "rationale": "取等条件遗漏", "probe_history": [], "created_at": "2026-08-18T00:00:00Z"}') on conflict (claim_id) do nothing;
insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
values ('art_clm_demo_03c', 'tnt_dev00001', 's_demo_03c', 'question_card', 'native_card', 'artifact://s_demo_03c/art_clm_demo_03c') on conflict (artifact_id) do nothing;
insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
values ('att_demo_03c_2', 'tnt_dev00001', 's_demo_03c', 'usr_student03', '{"answer_text": "a=b=5、C=60° 时 c=5，构成等边三角形 ✓，取等可达，S_max=25√3/4。", "kind": "probe", "submitted_at": "2026-08-18T00:00:00Z"}') on conflict (attempt_id) do nothing;
insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
values ('jud_demo_03c_2', 'tnt_dev00001', 's_demo_03c', 'att_demo_03c_2', 'correct', 'low', 'demo.model', 'teach-grade@0.4.0', '{"judgment_id": "jud_demo_03c_2", "session_id": "s_demo_03c", "attempt_id": "att_demo_03c_2", "verdict": "correct", "rubric_items": [{"id": "probe.judge", "status": "met", "evidence_refs": ["probe://s_demo_03c/att_demo_03c_2"]}], "decision_summary": "取等验证完整。", "uncertainty": "low", "injection_flags": [], "kind": "probe", "model_id": "demo.model", "prompt_version": "teach-grade@0.4.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (judgment_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03c_1', 'tnt_dev00001', 'usr_student03', 'K_INEQUALITY', 'Q_EXT_004', 's_demo_03c', 'jud_demo_03c_1', 'success', true, 'rubric.area_expression', 0, '{"observation_id": "obs_s_demo_03c_1", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "question_id": "Q_EXT_004", "session_id": "s_demo_03c", "outcome": "success", "independent": true, "evidence_rule": "rubric.area_expression", "hint_level": 0, "evidence_refs": ["answer://s_demo_03c/att_demo_03c_1"], "model_version": "pi.scnet", "rule_version": "rubric.area_expression", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03c_2', 'tnt_dev00001', 'usr_student03', 'T_INEQUALITY_APPLY', 'Q_EXT_004', 's_demo_03c', 'jud_demo_03c_1', 'failure', true, 'rubric.inequality_apply', 0, '{"observation_id": "obs_s_demo_03c_2", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "T_INEQUALITY_APPLY", "question_id": "Q_EXT_004", "session_id": "s_demo_03c", "outcome": "failure", "independent": true, "evidence_rule": "rubric.inequality_apply", "hint_level": 0, "evidence_refs": ["answer://s_demo_03c/att_demo_03c_1"], "model_version": "pi.scnet", "rule_version": "rubric.inequality_apply", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)
values ('obs_s_demo_03c_3', 'tnt_dev00001', 'usr_student03', 'K_INEQUALITY', 'Q_EXT_004', 's_demo_03c', 'jud_demo_03c_2', 'success', false, 'probe.judge', 0, '{"observation_id": "obs_s_demo_03c_3", "tenant_id": "tnt_dev00001", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "question_id": "Q_EXT_004", "session_id": "s_demo_03c", "outcome": "success", "independent": false, "evidence_rule": "probe.judge", "hint_level": 0, "evidence_refs": ["probe://s_demo_03c/att_demo_03c_2"], "model_version": "pi.scnet", "rule_version": "probe.judge", "supersedes": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (observation_id) do nothing;
insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)
values ('ser_demo_03c', 'tnt_dev00001', 's_demo_03c', 'usr_student03', 'K_INEQUALITY', 0.975, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', '{"report_id": "ser_demo_03c", "session_id": "s_demo_03c", "student_id": "usr_student03", "dimension_id": "K_INEQUALITY", "p_bkt_baseline": 0.975, "independent_observation_count": 3, "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only", "input_event_refs": ["obs_s_demo_03c_1", "obs_s_demo_03c_2", "obs_s_demo_03c_3"], "calculation_trace_ref": "calc_s_demo_03c", "kernel_version": "mastery-bkt@0.1.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (report_id) do nothing;
insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
values ('tss_demo_03c', 'tnt_dev00001', 's_demo_03c', 'ser_demo_03c', 'demo.model', 'teach-summary@0.3.0', '{"summary_id": "tss_demo_03c", "session_id": "s_demo_03c", "scientific_evaluation_ref": "ser_demo_03c", "summary": "面积上界算出但取等条件 a=b=5 未验证可达；追问后确认取等成立，结论修正为 25√3/4。", "method_observations": [], "misconception_candidates": [{"claim_id": "clm_demo_03c", "status": "resolved"}], "hint_dependency": "low", "unresolved": [], "evidence_refs": ["answer://s_demo_03c/att_demo_03c_1"], "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (summary_id) do nothing;
insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)
values ('slr_demo_03c', 'tnt_dev00001', 's_demo_03c', 'usr_student03', 'ser_demo_03c', 'tss_demo_03c', true, now(), '{"record_id": "slr_demo_03c", "session_id": "s_demo_03c", "student_id": "usr_student03", "scientific_evaluation_report_id": "ser_demo_03c", "teaching_session_summary_id": "tss_demo_03c", "integrity_check": {"session_id_match": true, "cross_refs_present": true, "provenance_complete": true, "passed": true}, "dream_queued_at": "2026-08-18T00:00:00Z", "created_at": "2026-08-18T00:00:00Z"}') on conflict (record_id) do nothing;
insert into state_profile_update_decision (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes, review_required, model_id, prompt_version, skill_version, payload)
values ('pud_demo_03', 'tnt_dev00001', 'usr_student03', null, null, null, false, 'demo.model', 'dream-profile@0.5.0', 'profile-skill@0.3.0', '{"decision_id": "pud_demo_03", "student_id": "usr_student03", "prior_snapshot_id": null, "baseline_report_refs": ["ser_demo_03a", "ser_demo_03b", "ser_demo_03c"], "teaching_summary_refs": ["tss_demo_03a", "tss_demo_03b", "tss_demo_03c"], "dimension_updates": [{"dimension_id": "K_INEQUALITY", "p_baseline": 0.975, "p_final": 0.99, "state_final": "possibly_mastered", "uncertainty": "low", "evidence_ledger": [{"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0, "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03a_1"], "explanation": "两题不等式配凑方法独立使用正确"}, {"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3, "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03b_2"], "explanation": "不同题型背景下方法选择稳定"}]}, {"dimension_id": "T_INEQUALITY_APPLY", "p_baseline": 0.194, "p_final": 0.238, "state_final": "weak", "uncertainty": "low", "evidence_ledger": [{"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3, "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03a_2"], "explanation": "最值题型方法选择稳定，取等经追问验证后修正"}]}], "semantic_profile_updates": [], "review_required": false, "model_id": "demo.model", "prompt_version": "dream-profile@0.5.0", "skill_version": "profile-skill@0.3.0", "created_at": "2026-08-18T00:00:00Z"}') on conflict (decision_id) do nothing;
insert into state_profile_decision_validation (validation_id, tenant_id, decision_id, result, validator_version, payload)
values ('pvr_demo_03', 'tnt_dev00001', 'pud_demo_03', 'passed', 'profile-validator-0.2.0', '{"validation_id": "pvr_demo_03", "decision_id": "pud_demo_03", "result": "passed", "validator_version": "profile-validator-0.2.0", "validated_at": "2026-08-18T00:00:00Z"}') on conflict (validation_id) do nothing;
insert into state_student_snapshot (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)
values ('snap_demo_03', 'tnt_dev00001', 'usr_student03', 'pud_demo_03', null, false, '{"snapshot_id": "snap_demo_03", "student_id": "usr_student03", "source_decision_id": "pud_demo_03", "supersedes": null, "dimensions": [{"dimension_id": "K_INEQUALITY", "p_profile": 0.99, "p_bkt_baseline": 0.975, "state": "possibly_mastered", "uncertainty": "low", "independent_observation_count": 3}, {"dimension_id": "T_INEQUALITY_APPLY", "p_profile": 0.238, "p_bkt_baseline": 0.194, "state": "weak", "uncertainty": "low", "independent_observation_count": 2}], "misconceptions": [{"error_cause_id": "E_RANGE_END_MISS", "state": "improving", "evidence_refs": ["claim://clm_demo_03c"]}], "semantic_profile": {}, "profile_lag": false}') on conflict (snapshot_id) do nothing;
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student03', 'K_INEQUALITY', 0.99, 'possibly_mastered', 'pud_demo_03')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values ('tnt_dev00001', 'usr_student03', 'T_INEQUALITY_APPLY', 0.238, 'weak', 'pud_demo_03')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();
insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)
values ('tnt_dev00001', 'usr_student03', 'E_RANGE_END_MISS', 'improving', '["claim://clm_demo_03c"]') on conflict (student_id, error_cause_id) do nothing;
insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable, updated_at)
values ('tnt_dev00001', 'usr_student03', 'K_INEQUALITY', '{"0.5": 0.125, "1": 0.125, "2": 0.125, "4": 0.125, "8": 0.125, "16": 0.125, "32": 0.125, "64": 0.125}', null, false, now()) on conflict (student_id, dimension_id) do nothing;
insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)
values ('pln_usr_student03', 'tnt_dev00001', 'usr_student03', 4, '{"plan_id": "pln_usr_student03", "student_id": "usr_student03", "tenant_id": "tnt_dev00001", "horizon_weeks": 4, "explanation": "冲高分路径：不等式与面积最值取等专项（含取等验证习惯），再综合迁移与限时训练。", "tasks": [{"week": 1, "kind": "knowledge_review", "dimension_ids": ["K_INEQUALITY"], "criterion": "能独立复述该维度核心方法与适用条件", "review_condition": "下周低档练习正确率 ≥0.7", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["K_INEQUALITY"], "criterion": "低一档练习正确率 ≥0.7", "review_condition": "达标后进入原难度练习", "minutes": 30}, {"week": 2, "kind": "practice_normal", "dimension_ids": ["K_INEQUALITY"], "criterion": "原难度练习正确率 ≥0.7 且无提示", "review_condition": "独立复测到期后验证", "minutes": 30}, {"week": 1, "kind": "knowledge_review", "dimension_ids": ["T_INEQUALITY_APPLY"], "criterion": "能独立复述该维度核心方法与适用条件", "review_condition": "下周低档练习正确率 ≥0.7", "minutes": 30}, {"week": 1, "kind": "practice_easy", "dimension_ids": ["T_INEQUALITY_APPLY"], "criterion": "低一档练习正确率 ≥0.7", "review_condition": "达标后进入原难度练习", "minutes": 30}, {"week": 2, "kind": "practice_normal", "dimension_ids": ["T_INEQUALITY_APPLY"], "criterion": "原难度练习正确率 ≥0.7 且无提示", "review_condition": "独立复测到期后验证", "minutes": 30}], "plan_skipped": null, "created_at": "2026-08-18T00:00:00Z"}') on conflict (plan_id) do update set student_id = excluded.student_id, horizon_weeks = excluded.horizon_weeks, payload = excluded.payload;

-- fixtures 显式作为公共教学库发布，并建立演示教师的学生绑定。
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'knowledge_component',dimension_id,'public',null from content_knowledge_component on conflict do nothing;
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'question_type',dimension_id,'public',null from content_question_type on conflict do nothing;
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'error_cause',dimension_id,'public',null from content_error_cause on conflict do nothing;
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'diagnosis_rule',rule_id,'public',null from content_diagnosis_rule on conflict do nothing;
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'question',question_id,'public',null from content_question on conflict do nothing;
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'chapter_package',package_id,'public',null from content_chapter_package on conflict do nothing;
insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by,payload) values ('bind_fixture_01','tnt_dev00001','usr_teacher01','usr_student01','active','usr_teacher01','{"source":"fixtures"}') on conflict do nothing;
insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by,payload) values ('bind_fixture_02','tnt_dev00001','usr_teacher01','usr_student02','active','usr_teacher01','{"source":"fixtures"}') on conflict do nothing;
insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by,payload) values ('bind_fixture_03','tnt_dev00001','usr_teacher01','usr_student03','active','usr_teacher01','{"source":"fixtures"}') on conflict do nothing;

commit;
