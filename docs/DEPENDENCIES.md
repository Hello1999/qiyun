# 依赖检查记录

检查日期：2026-10-04。工作区采用 Node.js 24.15+、pnpm 11.25.0、标准 pnpm 锁文件。没有伪造包元数据或手工生成依赖完整性值；中断的大文件按官方 URL 分块补齐，并对照发布方完整性值校验。

## node-forge 签名验证公告

官方审计报告 `node-forge <=1.4.0` 存在 RSA PKCS#1 v1.5 验签问题，检查时尚无修复版本：[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。因此不能把依赖审计描述为零漏洞。

网关不调用 forge 的 CSR/证书签名验证函数。CSR 的公钥必须为 RSA 2048 位以上、指数 65537，签名算法必须为 SHA256-with-RSA；签名验证使用 Node.js `crypto.verify` 和原生 OpenSSL。TLS 证书链验证也由 Node.js TLS/Go TLS 完成。forge 保留用于 ASN.1/PEM 解析和本机证书生成。

验证包括有效 CSR、被破坏的签名、未配对客户端、过期/重复配对和身份作用域。此处说明当前调用路径的措施，不将上游包整体标记为已修复；后续仍需跟踪修复版本或替换证书构建库。
