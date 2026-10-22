import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { setLocaleForTest } from "@/i18n";

// 现有测试按中文界面断言；jsdom 的浏览器语言是 en-US，这里固定为中文（英文界面另有测试）
setLocaleForTest("zh");
