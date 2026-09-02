import path from "node:path";

export function pathsEqual(left, right) {
  const leftPath = String(left ?? "").trim();
  const rightPath = String(right ?? "").trim();
  if (!leftPath || !rightPath) return false;
  return path.relative(path.resolve(leftPath), path.resolve(rightPath)) === "";
}

export function isStrictlyInside(candidate, parent) {
  const candidatePath = String(candidate ?? "").trim();
  const parentPath = String(parent ?? "").trim();
  if (!candidatePath || !parentPath) return false;
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}
