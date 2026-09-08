import path from "node:path";
import { verifySourcePackage } from "./SourcePackage.mjs";
if (!process.argv[2]) throw new Error("Supply the source package directory.");
console.log(JSON.stringify(verifySourcePackage(path.resolve(process.argv[2]))));
