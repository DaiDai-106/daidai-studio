import { Box3, Mesh, type Object3D } from "three";

export function isGeometryMesh(object: Object3D): object is Mesh {
  return object instanceof Mesh && object.userData.overlay !== true;
}

// expandByObject 会递归包含隐藏子项和覆盖层，因此只累积可见网格的几何边界。
export function visibleGeometryBounds(root: Object3D) {
  root.updateWorldMatrix(true, true);
  const bounds = new Box3();
  root.traverseVisible((object) => {
    if (!isGeometryMesh(object)) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    if (object.geometry.boundingBox)
      bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  return bounds;
}
