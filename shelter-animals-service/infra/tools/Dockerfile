# Tool image for PCs without the AWS CLI: Node.js 24 + AWS CLI v2.
# Built automatically by infra/run.ps1 the first time (docker build -t shelter-tools infra/tools).
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip /var/lib/apt/lists/*
WORKDIR /work
