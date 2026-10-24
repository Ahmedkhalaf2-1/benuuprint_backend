import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { NormalizeCode, Trim } from '../transforms.js';

/** Field may be omitted (leave unchanged) or null (clear it); otherwise the other validators run. */
export const NullableOptional = () =>
  applyDecorators(
    ValidateIf((_, value) => value !== undefined && value !== null),
  );

export { IsOptional };

export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;

/** Required machine code: trimmed, upper-cased, UPPER_SNAKE_CASE. */
export const CodeField = (example = 'EXAMPLE_CODE') =>
  applyDecorators(
    ApiProperty({
      example,
      description: 'UPPER_SNAKE_CASE, unique, immutable',
    }),
    NormalizeCode(),
    Matches(CODE_PATTERN, {
      message:
        'code must be UPPER_SNAKE_CASE, 2-50 characters, starting with a letter',
    }),
  );

export const NameField = (max = 120) =>
  applyDecorators(
    ApiProperty(),
    Trim(),
    IsString(),
    MinLength(1),
    MaxLength(max),
  );

export const OptText = (max: number) =>
  applyDecorators(
    ApiPropertyOptional(),
    IsOptional(),
    Trim(),
    IsString(),
    MaxLength(max),
  );

export const NullableText = (max: number) =>
  applyDecorators(
    ApiPropertyOptional({ nullable: true }),
    NullableOptional(),
    Trim(),
    IsString(),
    MaxLength(max),
  );

export const OptInt = (min: number, max: number) =>
  applyDecorators(
    ApiPropertyOptional(),
    IsOptional(),
    IsInt(),
    Min(min),
    Max(max),
  );

export const NullableInt = (min: number, max: number) =>
  applyDecorators(
    ApiPropertyOptional({ nullable: true }),
    NullableOptional(),
    IsInt(),
    Min(min),
    Max(max),
  );

export const OptBool = () =>
  applyDecorators(ApiPropertyOptional(), IsOptional(), IsBoolean());

export const OptEnum = (enumType: object) =>
  applyDecorators(
    ApiPropertyOptional({ enum: enumType }),
    IsOptional(),
    IsEnum(enumType),
  );

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };
export const NullableMoney = () =>
  applyDecorators(
    ApiPropertyOptional({ nullable: true, type: Number, example: 150 }),
    NullableOptional(),
    IsNumber(MONEY),
    Min(0),
    Max(9_999_999_999.99),
  );

export const NullableUuid = () =>
  applyDecorators(
    ApiPropertyOptional({ nullable: true, format: 'uuid' }),
    NullableOptional(),
    IsUUID(),
  );

export const OptUuid = () =>
  applyDecorators(
    ApiPropertyOptional({ format: 'uuid' }),
    IsOptional(),
    IsUUID(),
  );

export const NullableEnum = (enumType: object) =>
  applyDecorators(
    ApiPropertyOptional({ enum: enumType, nullable: true }),
    NullableOptional(),
    IsEnum(enumType),
  );

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const NullableHex = () =>
  applyDecorators(
    ApiPropertyOptional({ nullable: true, example: '#1A2B3C' }),
    NullableOptional(),
    Matches(HEX_COLOR, { message: 'must be a hex colour like #1A2B3C' }),
  );
