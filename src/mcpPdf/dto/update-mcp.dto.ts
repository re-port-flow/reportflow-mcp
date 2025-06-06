import { PartialType } from '@nestjs/mapped-types';
import { CreateMcpDto } from './create-mcp.dto';

export class UpdateMcpDto extends PartialType(CreateMcpDto) {}
