import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { ulid } from 'ulid';
import {
  Workspace,
  DesignVersion,
  FileModel,
} from '@/application/gateways/model';
import { DesignEntity } from '@/application/domain/entity';

@Entity('t_design')
export class Design {
  @PrimaryColumn({
    default: ulid(),
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
  })
  workspaceId: string;

  @Column({
    name: 'label',
    type: 'varchar',
    length: 80,
  })
  label: string;

  @Column({
    name: 'thumbnail',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  thumbnail?: string;

  @Column({
    name: 'latest_version',
    type: 'integer',
    default: 1,
  })
  latestVersion: number;

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

  @ManyToOne(() => Workspace, (workspace) => workspace.designs)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;

  @OneToMany(() => DesignVersion, (version) => version.design)
  @JoinColumn({ name: 'design_id', referencedColumnName: 'id' })
  versions: DesignVersion[];

  @OneToMany(() => FileModel, (file) => file.design)
  @JoinColumn({ name: 'design_id', referencedColumnName: 'id' })
  files: FileModel[];

  toEntity(): DesignEntity {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      label: this.label,
      latestVersion: this.latestVersion,
      updateAt: this.updatedAt,
      thumbnail: this.thumbnail,
      version: this.versions.map((version) => {
        return {
          version: version.version,
          thumbnail: version.thumbnail,
          width: version.width,
          height: version.height,
        };
      })[0],
    };
  }
}
