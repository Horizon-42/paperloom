// 中文文案：各模块一个文件。Messages 的结构以中文为准，其他语言必须一一对应（类型检查保证）。
import app from "./app";
import canvas from "./canvas";
import common from "./common";
import data from "./data";
import library from "./library";
import reader from "./reader";
import term from "./term";

export const zh = { common, app, library, reader, term, canvas, data };

export type Messages = typeof zh;
