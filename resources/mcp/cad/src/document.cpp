#include "private/document_internal.h"

namespace dai::cad
{
CadDocument::CadDocument( SourceVersion source ) : impl_( std::make_unique<Impl>() )
{
  impl_->source = std::move( source );
}
CadDocument::~CadDocument() = default;
const SourceVersion &CadDocument::source() const noexcept
{
  return impl_->source;
}
std::span<const CadObject> CadDocument::objects() const noexcept
{
  return impl_->objects;
}
const std::vector<std::string> &CadDocument::roots() const noexcept
{
  return impl_->roots;
}
const std::vector<std::string> &CadDocument::lengthUnits() const noexcept
{
  return impl_->source.length_units;
}
CadDocument::Impl &CadDocument::storage() noexcept
{
  return *impl_;
}
const CadDocument::Impl &CadDocument::storage() const noexcept
{
  return *impl_;
}
const CadObject &CadDocument::object( const std::string &id ) const
{
  const auto it = impl_->object_indices.find( id );
  if ( it == impl_->object_indices.end() ) {
    fail( "NOT_FOUND", "CAD object does not exist in this document." );
  }
  return impl_->objects[ it->second ];
}
}  // namespace dai::cad
