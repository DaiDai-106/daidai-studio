#ifndef DAI_CAD_DOCUMENT_INTERNAL_H
#define DAI_CAD_DOCUMENT_INTERNAL_H

#include "cad/document.h"
#include <map>
#include <unordered_map>
#include <TDocStd_Document.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Shape.hxx>

namespace dai::cad
{
struct CadGeometry {
  std::string id;
  TopoDS_Shape shape;
  TopTools_IndexedMapOfShape faces;
  TopTools_IndexedMapOfShape edges;
  TopTools_IndexedMapOfShape vertices;
  std::vector<std::optional<Rgba>> face_colors;
};
struct CadDocument::Impl {
  SourceVersion source;
  Handle( TDocStd_Document ) document;
  std::vector<CadObject> objects;
  std::unordered_map<std::string, std::size_t> object_indices;
  std::vector<std::string> roots;
  std::map<std::string, CadGeometry> geometries;
  std::unordered_map<std::string, Rgba> instance_color_overrides;
};
[[nodiscard]] std::string topologyId( const CadGeometry &geometry, const std::string &kind, int index );
}  // namespace dai::cad
#endif  // DAI_CAD_DOCUMENT_INTERNAL_H
