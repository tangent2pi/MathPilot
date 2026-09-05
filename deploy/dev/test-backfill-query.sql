-- 测试回填查询匹配情况
\encoding utf8

-- Test 1: √ 字符匹配
select count(*) as sqrt_match
from content_paper_answer_item
where answer_text ~ '√' OR analysis_text ~ '√';

-- Test 2: ^ 字符匹配（转义）
select count(*) as caret_match
from content_paper_answer_item
where answer_text ~ '\^' OR analysis_text ~ '\^';

-- Test 3: 混合匹配
select count(*) as mixed_match
from content_paper_answer_item
where answer_text ~ '√|\^' OR analysis_text ~ '√|\^';

-- Test 4: 列出"三角形"卷的 answer_text 样例
select item_order, left(answer_text, 80) as answer_preview
from content_paper_answer_item
where paper_id = 'paper_1142da87bc644f628b0a'
order by item_order
limit 3;
