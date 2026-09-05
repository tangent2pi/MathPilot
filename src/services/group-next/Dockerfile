# syntax=docker/dockerfile:1.7
# group-next：给已成型试卷出 PDF，XeLaTeX + ctex(fontset=noto) 编译本项目结构化题目。
# 依赖 TeX Live（xelatex + lang-chinese）+ Noto CJK 字体，无法复用共享 Node 服务镜像，
# 故自带 Dockerfile。
FROM node:24-bookworm-slim
ENV NODE_ENV=production

# Debian bookworm 默认用 deb822 的 /etc/apt/sources.list.d/debian.sources；换阿里云镜像加速。
RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    && sed -i 's@deb.debian.org@mirrors.aliyun.com@g; s@security.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-xetex \
      texlive-lang-chinese \
      texlive-latex-recommended \
      fonts-noto-cjk \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

# 按组卷 skill 规定装载 Windows 中文字体（华文行楷/黑体/宋体/Times New Roman），
# 供 XeLaTeX + fontspec 以 family 名检索；装后重建 fontconfig 缓存。
COPY src/services/group-next/fonts /usr/share/fonts/mathpilot
RUN fc-cache -f >/dev/null 2>&1 || true

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=mathpilot-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild

CMD exec corepack pnpm --filter @mathpilot/group-next run start