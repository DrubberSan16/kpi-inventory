import { Type } from '@nestjs/common';
import { OmitType, PartialType } from '@nestjs/swagger';

export const AUDIT_FIELDS = [
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'is_deleted',
  'deleted_at',
  'deleted_by',
] as const;

export function buildCrudRequestDtos<T extends Type<object>>(entity: T) {
  const BaseCreateDto = OmitType(entity, AUDIT_FIELDS as never);

  class CreateDto extends BaseCreateDto {}
  Object.defineProperty(CreateDto, 'name', {
    value: `Create${entity.name}Dto`,
  });

  class UpdateDto extends PartialType(CreateDto) {}
  Object.defineProperty(UpdateDto, 'name', {
    value: `Update${entity.name}Dto`,
  });

  return { CreateDto, UpdateDto };
}
