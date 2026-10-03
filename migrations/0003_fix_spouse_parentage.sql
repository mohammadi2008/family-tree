-- 0003_fix_spouse_parentage.sql
-- A marriage must only create a spouse link. If a husband's father/mother is the SAME
-- person as his wife's father/mother, he would be her sibling (such marriages are rejected
-- by the API), so that parent link is a leftover of a wrong "married = child of her parents"
-- record. Only this unambiguous case is cleared; every other relationship is untouched.
UPDATE persons SET father_id = NULL
WHERE gender = 'm' AND father_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM marriages m JOIN persons w ON w.id = m.wife_id
              WHERE m.husband_id = persons.id AND w.father_id = persons.father_id);
UPDATE persons SET mother_id = NULL
WHERE gender = 'm' AND mother_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM marriages m JOIN persons w ON w.id = m.wife_id
              WHERE m.husband_id = persons.id AND w.mother_id = persons.mother_id);
