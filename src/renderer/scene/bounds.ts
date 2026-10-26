import { Box3, Mesh, type Object3D } from "three";

export function isGeometryMesh(object: Object3D): object is Mesh {
  return object instanceof Mesh && object.userData.overlay !== true;
}

// expandByObject recursively includes hidden children and overlays of a mesh.
// Accumulate each visible mesh's own geometry instead.
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
