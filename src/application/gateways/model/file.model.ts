import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Design } from '@/application/gateways/model';
import { FileEntity } from '@/application/domain/entity';
@Entity('t_file')
export class FileModel {
  @PrimaryColumn({
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
    name: 'export_size',
    type: 'integer',
  })
  exportSize: number;

  @Column({
    name: 'export_date',
    type: 'datetime',
  })
  exportDate: Date;

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

  @ManyToOne(() => Design, (design) => design.files)
  @JoinColumn({ name: 'design_id', referencedColumnName: 'id' })
  design: Design;

  toEntity(): FileEntity {
    return {
      id: this.id,
      designId: this.designId,
      version: this.version,
      exportDate: this.exportDate,
      exportSize: this.exportSize,
      design: this.design.toEntity(),
    };
  }
}
