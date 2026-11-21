# 签名密钥：AOSP 公开测试密钥

这两个文件是 **Android 源码树自带**的公开测试密钥（`build/target/product/security/`），
Google 以 Apache 2.0 发布，任何项目都可以自由使用。**不是任何人的私密密钥。**

- `testkey.pk8` — PKCS#8 DER 格式的 RSA-2048 私钥（1217 字节）
- `testkey.x509.pem` — 对应的 X.509 证书

```
Subject : C=US, ST=California, L=Mountain View, O=Android, OU=Android, CN=Android
Email   : android@android.com
有效期  : 2008-02-29 ~ 2035-07-17
SHA-256 : a40da80a59d170caa950cf15c18c454d47a39b26989d8b640ecd745ba71bf5dc
SHA-1   : 61ed377e85d386a8dfee6b864bd85b0bfaa5af81
```

## 为什么不用 release.jks

`apksigner` 可以直接接受 `--key <pk8> --cert <pem>`，**不需要 keystore、不需要口令**，
CI 上也不用 `keytool`。比"私钥 → PKCS#12 → JKS → 签名"这条路少三个可能出错的环节。

## 这个签名意味着什么

- ✅ 能正常安装、正常运行
- ✅ 与任何用同一套 testkey 签的 App 签名一致
- ⚠️ **不能**覆盖安装用其他密钥签的包（比如现在装的 `com.deepseek.harness.compat`）
- ⚠️ 公开密钥，不具备"证明这个包是我发布的"作用

本项目是自用验证，这三条都不构成问题。
