const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (req, file, cb) => {
    const allowed = [
      ".png", ".jpg", ".jpeg", ".gif", ".webp",
      ".pdf", ".txt", ".md", ".csv",
      ".xlsx", ".xls", ".docx", ".doc",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件格式: ${ext}`));
    }
  },
});

app.use(express.static("public"));
app.use(express.json());

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Generate Function Spec
app.post("/api/generate", upload.array("files", 20), async (req, res) => {
  try {
    const { apiKey, projectName, module, devType, background, requirements } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: "请提供 Anthropic API Key" });
    }
    if (!requirements) {
      return res.status(400).json({ error: "请填写业务需求" });
    }

    const client = new Anthropic({ apiKey });

    // Build content blocks for Claude
    const contentBlocks = [];

    // Process uploaded files
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const ext = path.extname(file.originalname).toLowerCase();

        if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
          // Image files - send as image content
          const imageData = fs.readFileSync(file.path);
          const base64 = imageData.toString("base64");
          const mediaTypes = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
          };
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaTypes[ext],
              data: base64,
            },
          });
          contentBlocks.push({
            type: "text",
            text: `[上传文件: ${file.originalname}]`,
          });
        } else if (ext === ".pdf") {
          // PDF files
          try {
            const pdfParse = require("pdf-parse");
            const pdfBuffer = fs.readFileSync(file.path);
            const pdfData = await pdfParse(pdfBuffer);
            contentBlocks.push({
              type: "text",
              text: `[PDF 文件: ${file.originalname}]\n\n${pdfData.text}`,
            });
          } catch {
            contentBlocks.push({
              type: "text",
              text: `[PDF 文件: ${file.originalname}] - 无法解析内容`,
            });
          }
        } else if ([".txt", ".md", ".csv"].includes(ext)) {
          // Text files
          const text = fs.readFileSync(file.path, "utf-8");
          contentBlocks.push({
            type: "text",
            text: `[文件: ${file.originalname}]\n\n${text}`,
          });
        } else {
          // Other files - note them
          contentBlocks.push({
            type: "text",
            text: `[文件: ${file.originalname}] - 已上传 (${ext} 格式，请根据文件名推断内容)`,
          });
        }
      }
    }

    // Add user requirements
    contentBlocks.push({
      type: "text",
      text: `
请根据以上所有上传的文件内容和以下信息，生成一份完整、专业的 SAP Functional Specification 文档。

【项目信息】
- 项目名称：${projectName || "未指定"}
- SAP 模块：${module || "未指定"}
- 开发类型：${devType || "未指定"}

【业务背景】
${background || "未提供"}

【业务需求】
${requirements}

请按照以下结构输出完整的 Function Spec（使用 Markdown 格式）：

1. **Document Control / 文档控制** - 文档编号、版本、日期、审批表
2. **Executive Summary / 概述** - 目的、背景、范围
3. **Business Requirements / 业务需求** - As-Is 流程、To-Be 流程、业务规则
4. **Functional Requirements / 功能需求** - 输入字段（含表格）、处理逻辑（详细步骤）、输出字段、校验规则
5. **Technical Design / 技术设计** - 涉及的 SAP 表、BAPI/FM、事务码；如果是报表要包含选择屏幕和 ALV 布局；如果是接口要包含字段映射；如果是增强要包含增强点；如果是表单要包含布局
6. **Authorization / 权限** - 权限对象和检查
7. **Error Handling / 错误处理** - 错误代码、条件、消息、处理方式
8. **Testing Scenarios / 测试场景** - 完整的测试用例表
9. **Dependencies / 依赖关系**
10. **Appendix / 附录**

要求：
- 中英文双语标题
- 所有字段列表用表格形式
- 处理逻辑要详细到可以直接用于 ABAP 开发
- 包含具体的 SAP 标准表名和字段名
- 测试场景要包含正向和反向测试
- 用专业的 SAP 顾问语言
`,
    });

    // Call Claude API with streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: contentBlocks,
        },
      ],
      system:
        "你是一位资深 SAP 功能顾问，拥有 15 年以上 SAP 实施经验，精通 FI/CO/MM/SD/PP/HR 等模块。你的任务是根据用户提供的文档和需求，生成专业、完整、可直接用于开发的 SAP Functional Specification 文档。请确保技术细节准确，包括正确的 SAP 表名、字段名、事务码和 BAPI。",
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

    // Clean up uploaded files
    if (req.files) {
      for (const file of req.files) {
        fs.unlink(file.path, () => {});
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
    // If headers already sent (streaming started), end the stream with error
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: error.message || "生成失败，请重试" })}\n\n`
      );
      res.end();
    } else {
      res.status(500).json({ error: error.message || "生成失败，请重试" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  SAP Function Spec Generator`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
