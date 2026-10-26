#ifndef DAI_CAD_DOCUMENT_H
#define DAI_CAD_DOCUMENT_H

#include "cad/types.h"
#include <memory>
#include <span>

namespace dai::cad
{
class CadDocument final
{
 public:
  struct Impl;
  explicit CadDocument( SourceVersion source );
  ~CadDocument();
  CadDocument( const CadDocument & )            = delete;
  CadDocument &operator=( const CadDocument & ) = delete;
  [[nodiscard]] const SourceVersion &source() const noexcept;
  [[nodiscard]] std::span<const CadObject> objects() const noexcept;
  [[nodiscard]] const CadObject &object( const std::string &id ) const;
  [[nodiscard]] const std::vector<std::string> &roots() const noexcept;
  [[nodiscard]] const std::vector<std::string> &lengthUnits() const noexcept;
  // Internal core access only; neither protocol nor host receives an OCCT object.
  [[nodiscard]] Impl &storage() noexcept;
  [[nodiscard]] const Impl &storage() const noexcept;

 private:
  std::unique_ptr<Impl> impl_;
};
}  // namespace dai::cad
#endif  // DAI_CAD_DOCUMENT_H
