import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';
import { Design } from '@/application/gateways/model/design.model';

@Entity('t_design_version')
export class DesignVersion {
  @PrimaryColumn({
    default: ulid(),
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    name: 'design_id',
    type: 'varchar',
    length: 255,
  })
  designId: string;

  @Column({
    name: 'version',
    type: 'integer',
  })
  version: number;

  @Column({
    name: 'width',
    type: 'integer',
    nullable: false,
  })
  width: number;
  @Column({
    name: 'height',
    type: 'integer',
    nullable: false,
  })
  height: number;

  @Column({
    name: 'is_edit',
    type: 'boolean',
    default: true,
  })
  isEdit: boolean;

  @Column({
    name: 'thumbnail',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  thumbnail?: string;

  @Column({
    name: 'create_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    nullable: false,
    foreignKeyConstraintName: 'create_user_cd',
  })
  createUserCd: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: false,
  })
  createdAt: Date;

  @Column({
    name: 'update_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    nullable: false,
    foreignKeyConstraintName: 'update_user_cd',
  })
  updateUserCd: string;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    nullable: false,
  })
  updatedAt: Date;

  @Column({
    name: 'delete_flag',
    default: false,
    nullable: false,
  })
  deleteFlag: boolean;

  @ManyToOne(() => Design, (design) => design.versions)
  @JoinColumn({ name: 'design_id', referencedColumnName: 'id' })
  design: Design;
}
