export const testRobot = `<robot name="bench &amp; arm">
  <material name="metal"><color rgba="0.6 0.7 0.8 1"/></material>
  <link name="base">
    <visual><geometry><box size="1 1 0.15"/></geometry><material name="metal"/></visual>
  </link>
  <link name="arm">
    <visual>
      <origin xyz="0.3 0 0"/>
      <geometry><cylinder radius="0.1" length="0.6"/></geometry>
    </visual>
  </link>
  <joint name="swivel" type="revolute">
    <parent link="base"/><child link="arm"/><origin xyz="0 0 0.2"/>
    <axis xyz="0 0 1"/><limit lower="-2" upper="2" effort="10" velocity="2"/>
  </joint>
</robot>`;
